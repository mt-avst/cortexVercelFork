import React from 'react';

/**
 * GamificationProgress Component
 * 
 * Displays user's points progress toward next reward tier.
 * Position: Directly under social proof line in hero area.
 * 
 * Example: "You're at 2,300 points → 2,700 for next $50 voucher [====----] 85%"
 */

interface GamificationProgressProps {
  currentPoints?: number;
  nextTierPoints?: number;
  nextTierReward?: string;
  className?: string;
}

// Default/placeholder values when no real data is available
const DEFAULT_CURRENT_POINTS = 2300;
const DEFAULT_NEXT_TIER_POINTS = 2700;
const DEFAULT_NEXT_TIER_REWARD = '$50 voucher';

const GamificationProgress: React.FC<GamificationProgressProps> = ({
  currentPoints = DEFAULT_CURRENT_POINTS,
  nextTierPoints = DEFAULT_NEXT_TIER_POINTS,
  nextTierReward = DEFAULT_NEXT_TIER_REWARD,
  className = '',
}) => {
  const progress = Math.min((currentPoints / nextTierPoints) * 100, 100);
  const pointsToGo = nextTierPoints - currentPoints;

  return (
    <div className={`gamification-progress ${className}`}>
      <div className="gamification-progress-text">
        <span className="gamification-current">
          {currentPoints.toLocaleString()} pts
        </span>
        <span className="gamification-arrow">→</span>
        <span className="gamification-target">
          {nextTierPoints.toLocaleString()} for {nextTierReward}
        </span>
      </div>
      <div className="gamification-progress-bar">
        <div 
          className="gamification-progress-fill" 
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={currentPoints}
          aria-valuemin={0}
          aria-valuemax={nextTierPoints}
          aria-label={`${Math.round(progress)}% progress to next reward`}
        />
      </div>
      <div className="gamification-progress-meta">
        <span className="gamification-percentage">{Math.round(progress)}%</span>
        <span className="gamification-remaining">{pointsToGo.toLocaleString()} pts to go</span>
      </div>
    </div>
  );
};

export default GamificationProgress;


