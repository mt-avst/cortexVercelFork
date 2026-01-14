import React from 'react';
import { MockReward } from '../utils/mockRewards';

/**
 * RewardBadge Component
 * 
 * Big, bold reward badge displayed in top-right corner of opportunity cards.
 * Features:
 * - High contrast with white stroke for photo background readability
 * - Orange accent color for rewards
 * - Subtle drop shadow for depth
 */

interface RewardBadgeProps {
  reward: MockReward;
  className?: string;
}

const RewardBadge: React.FC<RewardBadgeProps> = ({ reward, className = '' }) => {
  if (!reward.hasReward) {
    return null;
  }

  return (
    <div className={`reward-badge ${className}`}>
      <span className="reward-badge-text">{reward.display}</span>
    </div>
  );
};

export default RewardBadge;













