import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface Props { children: ReactNode; resetKey: string }
interface State { failed: boolean }

class Boundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route failed to load', error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return (
      <main role="alert" style={{ maxWidth: 600, margin: '4rem auto', padding: '1.5rem' }}>
        <h1>Page could not load</h1>
        <p>Check your connection, then reload to try again.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </main>
    );
    return this.props.children;
  }
}

export default function ChunkErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <Boundary resetKey={location.pathname}>{children}</Boundary>;
}
