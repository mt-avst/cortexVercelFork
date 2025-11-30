import React, { useEffect } from 'react';
import UserProfileComponent from '../components/UserProfile';
import Leaderboard from '../components/Leaderboard';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { useTheme } from '../contexts/ThemeContext';
import { Trophy } from 'lucide-react';

const GamificationPage: React.FC = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Add page class to body for consistent styling
  useEffect(() => {
    document.body.classList.add('gamification-page-active');
    return () => {
      document.body.classList.remove('gamification-page-active');
    };
  }, []);

  return (
    <div className="admin-page-bg">
      {/* Theme-aware Background: Dark Mode gets neural particles */}
      {isDark && <SlowNeuralBackground />}
      
      <div className="container-fluid py-5" style={{ position: 'relative', zIndex: 10, maxWidth: '1400px' }}>
        {/* Page Title */}
        <h1 className="adaptabits-page-title">
          <Trophy size={32} />
          AdaptaBits
        </h1>

        {/* Hero Section: Profile + Prize (2-column grid handled by component) */}
        <UserProfileComponent />

        {/* Leaderboard Section */}
        <Leaderboard limit={20} />
      </div>
    </div>
  );
};

export default GamificationPage;
