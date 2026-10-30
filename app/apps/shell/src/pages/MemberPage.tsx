// /members/{token} and /customers/{token} (spec 11.4): the full 360 from search or a shared link.
// The member becomes the context chip of the composer, so the next question is about them.
import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from '../shell/uiStore.ts';
import { MemberRecord } from '../workspace/MemberRecord.tsx';
import page from './Page.module.css';

export function MemberPage() {
  const { ref = '' } = useParams();
  const { terms } = useSession();
  // The chip's label comes from the record itself, once the server has allowed it.
  const onLoaded = useCallback(
    (name: string) => {
      useUi.getState().addContext('new', { type: 'member', ref, label: name });
      useUi.getState().visit({ kind: 'view', path: `/${terms.personRoute}/${ref}`, label: name });
    },
    [ref, terms.personRoute],
  );

  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>{terms.Person} 360</h1>
      </header>
      <MemberRecord token={ref} onLoaded={onLoaded} />
    </div>
  );
}
