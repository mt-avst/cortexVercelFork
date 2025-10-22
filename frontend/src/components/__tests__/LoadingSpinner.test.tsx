import React from 'react';
import { render } from '@testing-library/react';
import LoadingSpinner from '../LoadingSpinner';

describe('LoadingSpinner Component', () => {
  it('should render with default props', () => {
    const { getByText } = render(<LoadingSpinner />);
    
    expect(getByText('Loading...')).toBeInTheDocument();
  });

  it('should render with custom text', () => {
    const { getByText } = render(<LoadingSpinner text="Custom loading text" />);
    
    expect(getByText('Custom loading text')).toBeInTheDocument();
  });

  it('should render without crashing', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('should render with different sizes', () => {
    const { container: smallContainer } = render(<LoadingSpinner size="small" />);
    const { container: mediumContainer } = render(<LoadingSpinner size="medium" />);
    const { container: largeContainer } = render(<LoadingSpinner size="large" />);
    
    expect(smallContainer.firstChild).toBeInTheDocument();
    expect(mediumContainer.firstChild).toBeInTheDocument();
    expect(largeContainer.firstChild).toBeInTheDocument();
  });
});
