// What a person sees if a page fails to load: never the router's developer screen. A page from an
// older release reloads itself onto the new one; anything else offers a reload and a way Home.
import { useEffect } from 'react';
import { useRouteError } from 'react-router';
import { isStaleChunkError, reloadForNewRelease } from './staleBuild.ts';
import styles from './RouteError.module.css';

export function RouteError() {
  const error = useRouteError();
  const stale = isStaleChunkError(error);
  useEffect(() => {
    if (stale) reloadForNewRelease();
  }, [stale]);
  return (
    <main className={styles.wrap} role="alert">
      <h1 className={styles.title}>{stale ? 'DI has been updated' : 'This page didn’t load'}</h1>
      <p className={styles.text}>{stale ? 'Loading the latest version…' : 'Something went wrong while opening it. Reloading usually fixes it; your work in DI is saved.'}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => window.location.reload()}>
          Reload
        </button>
        <a className={styles.secondary} href="/home">
          Go to Home
        </a>
      </div>
    </main>
  );
}
