use serde::{Deserialize, Serialize};

pub const HEADER: [u8; 2] = [0x55, 0xAA];
pub const MCU_TX_VER: u8 = 0x03;

pub const CMD_HEARTBEAT: u8 = 0x00;
pub const CMD_PRODUCT_INFO: u8 = 0x01;
pub const CMD_WORK_MODE: u8 = 0x02;
pub const CMD_WIFI_STATE: u8 = 0x03;
pub const CMD_WIFI_RESET: u8 = 0x04;
pub const CMD_WIFI_SELECT_MODE: u8 = 0x05;
pub const CMD_DP_DOWNLOAD: u8 = 0x06;
pub const CMD_DP_REPORT: u8 = 0x07;
pub const CMD_QUERY_ALL_DP: u8 = 0x08;
pub const CMD_MCU_OTA_START: u8 = 0x0a;
pub const CMD_MCU_OTA_DATA: u8 = 0x0b;
pub const CMD_GET_GREEN_TIME: u8 = 0x0c;
pub const CMD_QUERY_MEMORY: u8 = 0x0f;
pub const CMD_GET_LOCAL_TIME: u8 = 0x1c;
pub const CMD_QUERY_SIGNAL_STRENGTH: u8 = 0x24;
pub const CMD_HEARTBEAT_STOP: u8 = 0x25;
pub const CMD_GET_WIFI_STATUS: u8 = 0x2b;
pub const CMD_GET_MAC: u8 = 0x2d;
pub const CMD_NEW_FUNCTION_NOTICE: u8 = 0x37;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    pub version: u8,
    pub command: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct FrameParser {
    buffer: Vec<u8>,
}

impl FrameParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Frame> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();

        loop {
            let Some(start) = self.buffer.windows(2).position(|win| win == HEADER) else {
                // 串口 read 可能刚好把帧头拆成单字节 0x55 和下一次的 0xAA。
                // 找不到完整 55 AA 时，只保留末尾可能成为下一帧帧头的 0x55，避免官方助手可识别的半包在这里被清掉。
                if self.buffer.last().copied() == Some(HEADER[0]) {
                    self.buffer.drain(..self.buffer.len() - 1);
                } else {
                    self.buffer.clear();
                }
                break;
            };
            if start > 0 {
                self.buffer.drain(..start);
            }
            if self.buffer.len() < 7 {
                break;
            }
            let len = u16::from_be_bytes([self.buffer[4], self.buffer[5]]) as usize;
            let full_len = 7 + len;
            if self.buffer.len() < full_len {
                break;
            }
            let raw: Vec<u8> = self.buffer.drain(..full_len).collect();
            if checksum(&raw[..raw.len() - 1]) != raw[raw.len() - 1] {
                // 校验失败只丢弃当前候选帧头，继续寻找后续 55 AA，避免一个坏帧吞掉后面的好帧。
                self.buffer.splice(0..0, raw[1..].iter().copied());
                continue;
            }
            frames.push(Frame {
                version: raw[2],
                command: raw[3],
                payload: raw[6..6 + len].to_vec(),
            });
        }

        frames
    }
}

pub fn build_frame(command: u8, payload: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(payload.len() + 7);
    raw.extend_from_slice(&HEADER);
    // 涂鸦通用 MCU SDK 中 MCU 发给模组使用 0x03，模组下发常见为 0x00，解析侧不限制版本。
    raw.push(MCU_TX_VER);
    raw.push(command);
    raw.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    raw.extend_from_slice(payload);
    raw.push(checksum(&raw));
    raw
}

pub fn checksum(bytes: &[u8]) -> u8 {
    bytes
        .iter()
        .fold(0u8, |acc, value| acc.wrapping_add(*value))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_heartbeat_frame() {
        let mut parser = FrameParser::default();
        let frames = parser.push(&[0x55, 0xAA, 0x00, 0x00, 0x00, 0x00, 0xFF]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].command, CMD_HEARTBEAT);
        assert!(frames[0].payload.is_empty());
    }

    #[test]
    fn rejects_bad_checksum() {
        let mut parser = FrameParser::default();
        let frames = parser.push(&[0x55, 0xAA, 0x00, 0x00, 0x00, 0x00, 0x00]);
        assert!(frames.is_empty());
    }

    #[test]
    fn handles_sticky_frames() {
        let one = build_frame(CMD_HEARTBEAT, &[]);
        let two = build_frame(CMD_WIFI_STATE, &[0x04]);
        let mut parser = FrameParser::default();
        let frames = parser.push(&[one, two].concat());
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1].payload, vec![0x04]);
    }

    #[test]
    fn mcu_tx_uses_sdk_version() {
        let frame = build_frame(CMD_HEARTBEAT, &[0x01]);
        assert_eq!(frame[2], MCU_TX_VER);
    }

    #[test]
    fn preserves_single_55_across_reads() {
        let mut parser = FrameParser::default();
        assert!(parser.push(&[0x55]).is_empty());
        let frames = parser.push(&[0xAA, 0x00, 0x00, 0x00, 0x00, 0xFF]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].command, CMD_HEARTBEAT);
    }

    #[test]
    fn parses_official_assistant_reset_sequence_frames() {
        let mut parser = FrameParser::default();
        let reset_ack = parser.push(&[0x55, 0xAA, 0x00, 0x04, 0x00, 0x00, 0x03]);
        let heartbeat = parser.push(&[0x55, 0xAA, 0x00, 0x00, 0x00, 0x00, 0xFF]);
        let product = parser.push(&[0x55, 0xAA, 0x00, 0x01, 0x00, 0x00, 0x00]);
        let work_mode = parser.push(&[0x55, 0xAA, 0x00, 0x02, 0x00, 0x00, 0x01]);
        let wifi_state = parser.push(&[0x55, 0xAA, 0x00, 0x03, 0x00, 0x01, 0x01, 0x04]);

        assert_eq!(reset_ack[0].command, CMD_WIFI_RESET);
        assert_eq!(heartbeat[0].command, CMD_HEARTBEAT);
        assert_eq!(product[0].command, CMD_PRODUCT_INFO);
        assert_eq!(work_mode[0].command, CMD_WORK_MODE);
        assert_eq!(wifi_state[0].command, CMD_WIFI_STATE);
        assert_eq!(wifi_state[0].payload, vec![0x01]);
    }

    #[test]
    fn recovers_from_noise_and_bad_checksum_before_good_frame() {
        let mut parser = FrameParser::default();
        let frames = parser.push(&[
            0xFE, 0xFF, 0x55, 0xAA, 0x00, 0x00, 0x00, 0x00, 0x00, // bad checksum
            0x55, 0xAA, 0x00, 0x00, 0x00, 0x00, 0xFF,
        ]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].command, CMD_HEARTBEAT);
    }
}
