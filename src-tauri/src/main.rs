// Windows release 安装包不需要额外控制台窗口；开发模式保留控制台，方便查看调试输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tuya_mcu_simulator_assistant_lib::run()
}
