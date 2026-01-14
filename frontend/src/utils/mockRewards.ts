/**
 * Mock Reward System
 * 
 * Generates deterministic reward values based on opportunity ID hash.
 * This is a temporary placeholder until real reward_amount and reward_type
 * fields are added to the database.
 * 
 * Design decisions:
 * - Deterministic: Same ID always gets same reward (no flickering on re-render)
 * - Varied: $15-$85 cash, 150-750 points, $25-$50 vouchers
 * - ~85% of opportunities get rewards, ~15% are "no reward"
 */

export type RewardType = 'cash' | 'points' | 'voucher' | 'none';

export interface MockReward {
  type: RewardType;
  amount: number;
  display: string;
  hasReward: boolean;
}

// Reward pools for variety
const CASH_AMOUNTS = [15, 25, 35, 50, 75, 85];
const POINT_AMOUNTS = [150, 250, 500, 750];
const VOUCHER_AMOUNTS = [25, 50];

/**
 * Simple hash function for deterministic randomness
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Get mock reward for an opportunity
 * @param opportunityId - The opportunity's unique ID
 * @returns MockReward object with type, amount, and display string
 */
export function getMockReward(opportunityId: string): MockReward {
  const hash = hashCode(opportunityId);
  
  // ~15% chance of no reward (hash % 100 < 15)
  if (hash % 100 < 15) {
    return {
      type: 'none',
      amount: 0,
      display: 'No reward',
      hasReward: false,
    };
  }
  
  // Determine reward type based on hash
  const typeSelector = hash % 10;
  
  if (typeSelector < 5) {
    // 50% cash
    const amount = CASH_AMOUNTS[hash % CASH_AMOUNTS.length];
    return {
      type: 'cash',
      amount,
      display: `$${amount}`,
      hasReward: true,
    };
  } else if (typeSelector < 8) {
    // 30% points
    const amount = POINT_AMOUNTS[hash % POINT_AMOUNTS.length];
    return {
      type: 'points',
      amount,
      display: `${amount} pts`,
      hasReward: true,
    };
  } else {
    // 20% voucher
    const amount = VOUCHER_AMOUNTS[hash % VOUCHER_AMOUNTS.length];
    return {
      type: 'voucher',
      amount,
      display: `$${amount} Amazon`,
      hasReward: true,
    };
  }
}

/**
 * Get display text for the Start button
 * @param reward - MockReward object
 * @returns Button text like "Start · $50" or "Start · 500 pts"
 */
export function getStartButtonText(reward: MockReward): string {
  if (!reward.hasReward) {
    return 'Start';
  }
  return `Start · ${reward.display}`;
}

/**
 * Generate a deterministic "popular" count for an opportunity
 * Returns a number between 40-210 based on opportunity ID
 */
export function getPopularCount(opportunityId: string): number {
  const hash = hashCode(opportunityId);
  return 40 + (hash % 171); // 40 to 210
}

/**
 * Sort opportunities by reward status
 * Rewarded opportunities first, no-reward at the bottom with reduced opacity
 */
export function sortByRewardPriority<T extends { id: string }>(
  opportunities: T[]
): Array<T & { _hasReward: boolean; _reward: MockReward }> {
  return opportunities
    .map(opp => {
      const reward = getMockReward(opp.id);
      return {
        ...opp,
        _hasReward: reward.hasReward,
        _reward: reward,
      };
    })
    .sort((a, b) => {
      // Rewarded first, no-reward last
      if (a._hasReward && !b._hasReward) return -1;
      if (!a._hasReward && b._hasReward) return 1;
      return 0;
    });
}













