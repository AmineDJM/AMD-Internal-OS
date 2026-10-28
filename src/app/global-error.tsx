"use client";

import * as React from "react";
import { journal } from "@/lib/journal";

/**
 * QUAND LA RACINE ELLE-MÊME CASSE (audit 27/10, INFRA-11).
 *
 * `(app)/error.tsx` rattrape une page ; il ne peut rien pour une erreur du layout RACINE (ou de
 * `/login`), qui affichait la page par défaut de Next : en anglais, sans `digest`, sans rien pour
 * repartir. Ce fichier REMPLACE le layout racine quand il est actif — d'où `<html>` et `<body>`,
 * et des styles en ligne : la feuille globale peut ne pas être chargée à ce stade.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    journal.erreur("page.racine-impossible", { digest: error.digest ?? null }, error);
  }, [error]);

  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8fafc", color: "#0f172a" }}>
        <main style={{ maxWidth: 28 + "rem", margin: "15vh auto", padding: "0 1rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600 }}>L&apos;application n&apos;a pas pu s&apos;afficher.</h1>
          <p style={{ fontSize: "0.875rem", color: "#475569" }}>
            Réessayez dans un instant ; si cela se reproduit, signalez-le avec la référence ci-dessous.
          </p>
          {error.digest && (
            <p style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#475569" }}>réf. {error.digest}</p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "1rem" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", border: "1px solid #cbd5e1", background: "#0f172a", color: "#fff", cursor: "pointer" }}
            >
              Réessayer
            </button>
            <a href="/" style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", border: "1px solid #cbd5e1", color: "#0f172a", textDecoration: "none" }}>
              Revenir à l&apos;accueil
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
