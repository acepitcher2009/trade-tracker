import { Component } from 'react';

/** If a screen ever fails to draw, show a way out instead of a blank page. */
export default class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('Screen failed to draw', error); } // eslint-disable-line no-console
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="banner banner-warn" role="alert">
        <div className="banner-title">Something went wrong on this screen</div>
        <p className="hint">Your information is safe on this phone. Go back and try again. If it keeps happening, tell Jared what you tapped.</p>
        <button className="btn btn-primary" onClick={this.props.onBack}>Back to the list</button>
      </div>
    );
  }
}
