// Windows 下隐藏控制台窗口；其它平台此属性无效果
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    z_biz_tool_music_lib::run()
}
