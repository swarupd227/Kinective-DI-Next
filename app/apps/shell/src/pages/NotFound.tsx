import { Link } from 'react-router';
import page from './Page.module.css';

export function NotFound() {
  return (
    <div className={page.center}>
      <h1 className={page.title}>There is nothing at this address</h1>
      <p className={page.lede}>The link may be out of date. Press Ctrl+K to search, or go back to Home.</p>
      <Link to="/home">Go to Home</Link>
    </div>
  );
}
