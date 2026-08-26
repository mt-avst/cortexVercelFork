import api from './client';

export interface UserProfile {
  id: string;
  user_id: string;
  total_points: number;
  monthly_points: number;
  level: number;
  sessions_completed: number;
  surveys_completed: number;
  polls_completed: number;
  questions_completed: number;
  last_activity_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  points_required: number;
  category: 'participation' | 'milestone' | 'special';
  badge_color: string;
  created_at: string;
}

export interface UserAchievement {
  id: string;
  user_id: string;
  achievement_id: string;
  earned_at: string;
  achievement: Achievement;
}

// NO `user_id`: the leaderboards are unauthenticated and publish a name and a
// points total to anyone, so the join key is not part of the payload
// (cto/AdaptaLabs#17). Rows are keyed on `rank`, which is unique per board.
export interface LeaderboardEntry {
  name: string;
  total_points: number;
  monthly_points: number;
  level: number;
  rank: number;
}

export interface PointsTransaction {
  id: string;
  user_id: string;
  points: number;
  reason: string;
  opportunity_id: string | null;
  session_id: string | null;
  created_at: string;
}

// One page of the caller's own transactions. `has_more` reports that older rows
// exist (cto/AdaptaLabs#23); `next_before` is how they are asked for
// (cto/AdaptaLabs#47) - pass it back as the `before` argument below.
//
// ECHO `next_before` VERBATIM. Do NOT rebuild a cursor from a transaction's own
// `created_at`: the server stores microseconds and this JSON carries whatever
// `pg` and `Date` agreed on, so a hand-built cursor rounds down and skips rows.
// It is `null` exactly when `has_more` is false.
export interface PointsHistoryPage {
  transactions: PointsTransaction[];
  has_more: boolean;
  next_before: string | null;
}

export interface SessionCompletionResult {
  message: string;
  points: number;
  newLevel: number;
  levelUp: boolean;
  totalPoints: number;
}

// AdaptaBits API functions
export const gamificationApi = {
  // Get user's AdaptaBits profile
  getProfile: async (): Promise<UserProfile> => {
    const response = await api.get('/gamification/profile');
    return response.data;
  },

  // Get user's achievements
  getAchievements: async (): Promise<UserAchievement[]> => {
    const response = await api.get('/gamification/achievements');
    return response.data;
  },

  // Get global leaderboard
  getLeaderboard: async (limit: number = 10): Promise<LeaderboardEntry[]> => {
    const response = await api.get(`/gamification/leaderboard?limit=${limit}`);
    return response.data;
  },

  // Get monthly leaderboard
  getMonthlyLeaderboard: async (limit: number = 10): Promise<LeaderboardEntry[]> => {
    const response = await api.get(`/gamification/leaderboard/monthly?limit=${limit}`);
    return response.data;
  },

  // Get user's AdaptaBits history.
  //
  // Returns the PAGE, not the array. `has_more` is the only thing that
  // distinguishes a full page from the end of the caller's history - dropping it
  // here to keep the old signature would put the silent truncation straight back
  // (cto/AdaptaLabs#23).
  //
  // `before` is the previous page's `next_before` and nothing else
  // (cto/AdaptaLabs#47). encodeURIComponent because the cursor is a `<timestamp>,<id>`
  // pair: an unencoded `,` is legal in a query string and an unencoded `+`
  // would decode as a space.
  getPointsHistory: async (limit: number = 20, before?: string | null): Promise<PointsHistoryPage> => {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : '';
    const response = await api.get(`/gamification/points-history?limit=${limit}${cursor}`);
    return response.data;
  }
};

// Helper functions for AdaptaBits UI
export const gamificationUtils = {
  // Calculate AdaptaBits needed for next level
  getPointsToNextLevel: (currentLevel: number, totalPoints: number): number => {
    const levelThresholds = [
      0,    // Level 1
      50,   // Level 2
      120,  // Level 3
      200,  // Level 4
      300,  // Level 5
      450,  // Level 6
      650,  // Level 7
      900,  // Level 8
      1200, // Level 9
      1600, // Level 10
    ];
    
    const nextLevelThreshold = levelThresholds[currentLevel] || (currentLevel * 200);
    return Math.max(0, nextLevelThreshold - totalPoints);
  },

  // Calculate progress percentage to next level
  getLevelProgress: (currentLevel: number, totalPoints: number): number => {
    const levelThresholds = [
      0,    // Level 1
      50,   // Level 2
      120,  // Level 3
      200,  // Level 4
      300,  // Level 5
      450,  // Level 6
      650,  // Level 7
      900,  // Level 8
      1200, // Level 9
      1600, // Level 10
    ];
    
    const currentThreshold = levelThresholds[currentLevel - 1] || 0;
    const nextThreshold = levelThresholds[currentLevel] || (currentLevel * 200);
    const progress = totalPoints - currentThreshold;
    const range = nextThreshold - currentThreshold;
    
    return Math.min(100, Math.max(0, (progress / range) * 100));
  },

  // Get level title based on level number
  getLevelTitle: (level: number): string => {
    const titles = [
      'Newcomer',      // Level 1
      'Explorer',      // Level 2
      'Contributor',   // Level 3
      'Researcher',    // Level 4
      'Expert',        // Level 5
      'Specialist',    // Level 6
      'Master',        // Level 7
      'Champion',      // Level 8
      'Legend',        // Level 9
      'AdaptaLabs Hero' // Level 10+
    ];
    
    return titles[Math.min(level - 1, titles.length - 1)] || 'AdaptaLabs Hero';
  },

  // Get level color based on level number
  getLevelColor: (level: number): string => {
    const colors = [
      '#6c757d', // Level 1 - Gray
      '#28a745', // Level 2 - Green
      '#007bff', // Level 3 - Blue
      '#6f42c1', // Level 4 - Purple
      '#fd7e14', // Level 5 - Orange
      '#20c997', // Level 6 - Teal
      '#ffc107', // Level 7 - Yellow
      '#dc3545', // Level 8 - Red
      '#e83e8c', // Level 9 - Pink
      '#17a2b8'  // Level 10+ - Cyan
    ];
    
    return colors[Math.min(level - 1, colors.length - 1)] || '#17a2b8';
  },

  // Format AdaptaBits with appropriate suffix
  formatPoints: (points: number): string => {
    if (points >= 1000) {
      return `${(points / 1000).toFixed(1)}K`;
    }
    return points.toString();
  },

  // Get achievement category color
  getAchievementCategoryColor: (category: string): string => {
    switch (category) {
      case 'participation':
        return '#28a745';
      case 'milestone':
        return '#007bff';
      case 'special':
        return '#ffc107';
      default:
        return '#6c757d';
    }
  }
};
