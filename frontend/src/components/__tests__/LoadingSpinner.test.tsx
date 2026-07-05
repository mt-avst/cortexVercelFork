import React from 'react';
import { render } from '@testing-library/react';
import LoadingSpinner from '../LoadingSpinner';

describe('LoadingSpinner Component', () => {
  it('should render with default props', () => {
    // The spinner renders its text twice: a visually-hidden copy for screen
    // readers and the visible label
    const { getAllByText } = render(<LoadingSpinner />);

    expect(getAllByText('Loading...').length).toBeGreaterThan(0);
  });

  it('should render with custom text', () => {
    const { getAllByText } = render(<LoadingSpinner text="Custom loading text" />);

    expect(getAllByText('Custom loading text').length).toBeGreaterThan(0);
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
