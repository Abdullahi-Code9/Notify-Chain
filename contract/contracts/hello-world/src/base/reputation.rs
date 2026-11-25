use soroban_sdk::{contracttype, Address, Env};

/// Sender reputation score and metrics.
///
/// Tracks the reliability and performance of notification senders.
/// Reputation is updated based on successful and failed delivery attempts.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SenderReputation {
    pub sender: Address,
    pub total_sent: u32,
    pub successful_deliveries: u32,
    pub failed_deliveries: u32,
    pub reputation_score: i64,
    pub last_update: u64,
}

/// Reputation score tier classification.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReputationTier {
    /// Score: 0-20. Sender is brand new or has very poor record.
    Unverified = 0,
    /// Score: 21-60. Sender has some history with moderate issues.
    Bronze = 1,
    /// Score: 61-80. Sender has good track record.
    Silver = 2,
    /// Score: 81-95. Sender is highly reliable.
    Gold = 3,
    /// Score: 96-100. Sender has excellent track record.
    Platinum = 4,
}

/// Constants for reputation calculation.
pub const INITIAL_REPUTATION_SCORE: i64 = 50;
pub const MAX_REPUTATION_SCORE: i64 = 100;
pub const MIN_REPUTATION_SCORE: i64 = 0;
pub const SUCCESSFUL_DELIVERY_REWARD: i64 = 2;
pub const FAILED_DELIVERY_PENALTY: i64 = 5;

/// Determine the reputation tier based on score.
pub fn reputation_tier_from_score(score: i64) -> ReputationTier {
    match score {
        0..=20 => ReputationTier::Unverified,
        21..=60 => ReputationTier::Bronze,
        61..=80 => ReputationTier::Silver,
        81..=95 => ReputationTier::Gold,
        96..=100 => ReputationTier::Platinum,
        _ if score > 100 => ReputationTier::Platinum,
        _ => ReputationTier::Unverified,
    }
}

/// Calculate reputation score based on delivery history.
pub fn calculate_reputation_score(successful: u32, failed: u32) -> i64 {
    let total = successful.saturating_add(failed);
    if total == 0 {
        return INITIAL_REPUTATION_SCORE;
    }

    // Weight the score by the squared success rate so a perfect record reaches
    // the maximum, a balanced record lands well below it, and a record with no
    // successful deliveries bottoms out at the minimum.
    let success_rate = successful as f64 / total as f64;
    let score = (success_rate * success_rate * MAX_REPUTATION_SCORE as f64) as i64;

    // Clamp score to valid range
    if score > MAX_REPUTATION_SCORE {
        MAX_REPUTATION_SCORE
    } else if score < MIN_REPUTATION_SCORE {
        MIN_REPUTATION_SCORE
    } else {
        score
    }
}

impl SenderReputation {
    /// Create a new sender reputation record.
    pub fn new(sender: Address, current_time: u64) -> Self {
        SenderReputation {
            sender,
            total_sent: 0,
            successful_deliveries: 0,
            failed_deliveries: 0,
            reputation_score: INITIAL_REPUTATION_SCORE,
            last_update: current_time,
        }
    }

    /// Record a successful delivery and update reputation score.
    pub fn record_successful_delivery(&mut self, current_time: u64) {
        self.successful_deliveries = self.successful_deliveries.saturating_add(1);
        self.total_sent = self.total_sent.saturating_add(1);
        self.update_score();
        self.last_update = current_time;
    }

    /// Record a failed delivery and update reputation score.
    pub fn record_failed_delivery(&mut self, current_time: u64) {
        self.failed_deliveries = self.failed_deliveries.saturating_add(1);
        self.total_sent = self.total_sent.saturating_add(1);
        self.update_score();
        self.last_update = current_time;
    }

    /// Get the current reputation tier.
    pub fn get_tier(&self) -> ReputationTier {
        reputation_tier_from_score(self.reputation_score)
    }

    /// Get success rate as a percentage (0-100).
    pub fn get_success_rate(&self) -> u32 {
        if self.total_sent == 0 {
            0
        } else {
            ((self.successful_deliveries as u64 * 100) / self.total_sent as u64) as u32
        }
    }

    /// Update the reputation score based on delivery history.
    fn update_score(&mut self) {
        self.reputation_score = calculate_reputation_score(
            self.successful_deliveries,
            self.failed_deliveries,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reputation_tier_classification() {
        assert_eq!(reputation_tier_from_score(10), ReputationTier::Unverified);
        assert_eq!(reputation_tier_from_score(40), ReputationTier::Bronze);
        assert_eq!(reputation_tier_from_score(70), ReputationTier::Silver);
        assert_eq!(reputation_tier_from_score(85), ReputationTier::Gold);
        assert_eq!(reputation_tier_from_score(98), ReputationTier::Platinum);
    }

    #[test]
    fn test_reputation_score_calculation() {
        // No deliveries - should return initial score
        assert_eq!(calculate_reputation_score(0, 0), INITIAL_REPUTATION_SCORE);

        // Perfect success
        let perfect_score = calculate_reputation_score(100, 0);
        assert_eq!(perfect_score, MAX_REPUTATION_SCORE);

        // 50% success rate
        let half_score = calculate_reputation_score(50, 50);
        assert!(half_score >= 20 && half_score <= 30);

        // All failures
        let zero_score = calculate_reputation_score(0, 100);
        assert_eq!(zero_score, MIN_REPUTATION_SCORE);
    }

    #[test]
    fn test_sender_reputation_tracking() {
        let sender = {
            use soroban_sdk::testutils::Address as _;
            Address::generate(&Env::default())
        };
        let mut rep = SenderReputation::new(sender.clone(), 1000);

        assert_eq!(rep.reputation_score, INITIAL_REPUTATION_SCORE);
        assert_eq!(rep.total_sent, 0);

        // Record successful delivery
        rep.record_successful_delivery(1001);
        assert_eq!(rep.total_sent, 1);
        assert_eq!(rep.successful_deliveries, 1);
        assert!(rep.reputation_score >= INITIAL_REPUTATION_SCORE);

        // Record failed delivery
        rep.record_failed_delivery(1002);
        assert_eq!(rep.total_sent, 2);
        assert_eq!(rep.failed_deliveries, 1);
    }
}
