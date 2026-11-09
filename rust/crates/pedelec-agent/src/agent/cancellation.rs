use super::error::AgentError;
use std::sync::atomic::{AtomicU8, Ordering};

pub const TURN_INTERRUPTED: &str = "TURN_INTERRUPTED";

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;

/// Cancellation of one turn. Commit and cancel race on a single atomic so a
/// turn either commits or is interrupted, never both.
#[derive(Debug, Default)]
pub struct TurnCancellation {
    state: AtomicU8,
}

impl TurnCancellation {
    /// Returns false if the turn is already committing, which means it
    /// finished first.
    pub fn cancel(&self) -> bool {
        match self
            .state
            .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => true,
            Err(state) => state == CANCELLED,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::SeqCst) == CANCELLED
    }

    pub fn check(&self) -> Result<(), AgentError> {
        if self.is_cancelled() {
            return Err(interrupted_error());
        }
        Ok(())
    }

    /// Claims the turn for commit. After this a cancel can no longer win.
    pub fn begin_commit(&self) -> Result<(), AgentError> {
        match self
            .state
            .compare_exchange(RUNNING, COMMITTING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) | Err(COMMITTING) => Ok(()),
            Err(_) => Err(interrupted_error()),
        }
    }
}

pub fn interrupted_error() -> AgentError {
    AgentError::new(TURN_INTERRUPTED, "The turn was interrupted.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_and_cancel_have_exactly_one_winner() {
        let cancelled_first = TurnCancellation::default();
        assert!(cancelled_first.cancel());
        assert!(cancelled_first.cancel());
        assert!(cancelled_first.begin_commit().is_err());

        let committed_first = TurnCancellation::default();
        committed_first.begin_commit().unwrap();
        assert!(!committed_first.cancel());
        assert!(!committed_first.is_cancelled());
    }
}
