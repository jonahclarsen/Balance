// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if balance_lib::redirect_to_development_app() {
        return;
    }
    balance_lib::run();
}
