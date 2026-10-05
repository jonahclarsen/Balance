//! Timings for the opt-in synthetic theme profile. This module is absent from
//! production builds; other tests leave the thread-local collector disabled.

use std::cell::RefCell;
use std::time::Instant;

use serde_json::{json, Map, Value};

thread_local! {
    static TIMINGS: RefCell<Option<Map<String, Value>>> = const { RefCell::new(None) };
}

pub(crate) struct Phase {
    name: &'static str,
    started: Option<Instant>,
}

impl Phase {
    pub(crate) fn start(name: &'static str) -> Self {
        let started = TIMINGS.with(|timings| timings.borrow().is_some().then(Instant::now));
        Self { name, started }
    }
}

impl Drop for Phase {
    fn drop(&mut self) {
        let Some(started) = self.started else {
            return;
        };
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        TIMINGS.with(|timings| {
            if let Some(timings) = timings.borrow_mut().as_mut() {
                let previous = timings
                    .get(self.name)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                timings.insert(self.name.into(), json!(previous + elapsed_ms));
            }
        });
    }
}

pub(crate) fn capture<T>(run: impl FnOnce() -> T) -> (T, Map<String, Value>) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TIMINGS.with(|timings| {
                timings.borrow_mut().take();
            });
        }
    }

    TIMINGS.with(|timings| {
        let mut timings = timings.borrow_mut();
        assert!(timings.is_none(), "theme timing captures cannot be nested");
        *timings = Some(Map::new());
    });
    let _reset = Reset;
    let result = run();
    let timings = TIMINGS.with(|timings| timings.borrow_mut().take().unwrap());
    (result, timings)
}
