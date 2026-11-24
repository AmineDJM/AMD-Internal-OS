import * as React from "react";

export interface CitationAffichee {
  /** Extrait en texte brut — repli quand la voie de recherche ne surligne pas. */
  snippet: string;
  segments?: { texte: string; fort: boolean }[];
}

/**
 * L'extrait d'une citation du corpus, rendu en TEXTE : les termes trouvés deviennent des `<mark>`
 * construits ici, chaque segment est échappé par React. Le texte vient de pages de régulateurs
 * téléchargées — l'injecter comme HTML exécutait toute balise qu'une page y avait glissée
 * (XSS stockée dans la session du Super Admin). Composant sans état, rendu testé.
 */
export function ExtraitCitation({ c }: { c: CitationAffichee }) {
  const segments = c.segments ?? [{ texte: c.snippet, fort: false }];
  return (
    <p className="text-muted-foreground">
      {segments.map((s, i) => (s.fort ? <mark key={i} className="rounded bg-warning/20 px-0.5 text-foreground">{s.texte}</mark> : <span key={i}>{s.texte}</span>))}
    </p>
  );
}
