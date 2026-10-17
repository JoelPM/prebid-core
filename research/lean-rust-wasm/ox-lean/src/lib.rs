//! Lean Rust->WASM OpenX Shared Adapter (research prototype for prebid-core#10).
//!
//! `no_std`, no allocator, no serde, no core::fmt, no float parsing. The adapter logic in
//! `openx.rs` is written once against the tiny `Doc` trait below; two interchangeable backends
//! implement it:
//!   * `dom`     - bytes in / bytes out. A hand-written JSON scanner builds a node arena that
//!                 borrows spans of the input; an emitter writes the result. What a server Host
//!                 (wazero, Chicory/wasmtime, Trusted Server) would call.
//!   * `imports` - field by field. JS keeps the objects; wasm walks and edits them through a
//!                 handful of imported functions. What Prebid.js would call.
#![no_std]

#[cfg(all(feature = "dom", feature = "imports"))]
compile_error!("pick one backend");

#[cfg(feature = "dom")]
mod dom;
#[cfg(feature = "imports")]
mod imports;
#[cfg(not(feature = "floor"))]
mod openx;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    None = 0, // absent / undefined
    Null = 1,
    True = 2,
    False = 3,
    Num = 4,
    Str = 5,
    Arr = 6,
    Obj = 7,
}

/// The whole surface an Adapter author sees. Values are opaque `Copy` handles.
/// Absent values are `Kind::None` and every getter tolerates them, so chains like
/// `d.get(d.get(imp, "ext"), "bidder")` never need intermediate checks.
#[allow(dead_code)]
pub trait Doc {
    type V: Copy;
    fn kind(&mut self, v: Self::V) -> Kind;
    fn get(&mut self, o: Self::V, k: &'static str) -> Self::V;
    fn len(&mut self, v: Self::V) -> u32;
    fn at(&mut self, v: Self::V, i: u32) -> Self::V;
    /// key of the i-th entry of an object, as a string value
    fn key_at(&mut self, o: Self::V, i: u32) -> Self::V;
    fn str_eq(&mut self, v: Self::V, s: &'static str) -> bool;
    fn same_str(&mut self, a: Self::V, b: Self::V) -> bool;
    /// JS truthiness
    fn truthy(&mut self, v: Self::V) -> bool;
    /// number, or numeric string, > 0
    fn pos_num(&mut self, v: Self::V) -> bool;
    /// "0.4" -> 0.4 (numbers pass through); None if not numeric
    fn to_num(&mut self, v: Self::V) -> Self::V;
    /// 42 -> "42" (strings pass through)
    fn to_str(&mut self, v: Self::V) -> Self::V;
    fn obj(&mut self) -> Self::V;
    fn arr(&mut self) -> Self::V;
    fn lit(&mut self, s: &'static str) -> Self::V;
    fn int(&mut self, n: u32) -> Self::V;
    fn set(&mut self, o: Self::V, k: &'static str, v: Self::V);
    fn set_dyn(&mut self, o: Self::V, k: Self::V, v: Self::V);
    fn del(&mut self, o: Self::V, k: &'static str);
    fn push(&mut self, a: Self::V, v: Self::V);
    /// shallow copy of an object (None/non-object -> empty object)
    fn clone_obj(&mut self, o: Self::V) -> Self::V;

    fn get2(&mut self, o: Self::V, a: &'static str, b: &'static str) -> Self::V {
        let x = self.get(o, a);
        self.get(x, b)
    }
    fn has(&mut self, o: Self::V, k: &'static str) -> bool {
        let v = self.get(o, k);
        let kd = self.kind(v);
        kd != Kind::None && kd != Kind::Null
    }
}
