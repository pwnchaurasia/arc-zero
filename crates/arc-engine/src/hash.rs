//! FNV-1a 64-bit hashing for state fingerprints.
//!
//! Not a security primitive: it only lets the client confirm it simulated the
//! same result as the server. The server never trusts a client-sent hash.

#[derive(Clone, Debug)]
pub struct Fnv64(u64);

impl Default for Fnv64 {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Fnv64 {
    pub fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    pub fn write_u8(&mut self, v: u8) {
        self.write(&[v]);
    }

    pub fn write_u16(&mut self, v: u16) {
        self.write(&v.to_le_bytes());
    }

    pub fn write_u32(&mut self, v: u32) {
        self.write(&v.to_le_bytes());
    }

    pub fn write_i32(&mut self, v: i32) {
        self.write(&v.to_le_bytes());
    }

    #[must_use]
    pub fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}
