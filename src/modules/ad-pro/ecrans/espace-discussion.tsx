import type * as React from "react";

/**
 * UN SEUL ESPACE « DISCUSSION » EN BAS DE LA DEMANDE (Direction, 04/10) — le fil canonique de la demande
 * (`AdProDiscussionCard`) et, dessous, les échanges avec les personnes impliquées
 * (`InvolvementConversations`, absent quand il n'y en a pas). Les deux composants partagés restent tels
 * quels : on les ENVELOPPE dans une seule surface, leurs propres cartes aplaties, séparées d'un trait.
 */
export function EspaceDiscussion({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Discussion"
      className="surface divide-y divide-border overflow-hidden [&>.surface]:rounded-none [&>.surface]:border-0 [&>.surface]:bg-transparent [&>.surface]:shadow-none"
    >
      {children}
    </section>
  );
}
