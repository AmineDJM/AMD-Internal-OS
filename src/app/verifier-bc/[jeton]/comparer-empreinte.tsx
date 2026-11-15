"use client";

import * as React from "react";

/** Le fichier reçu est-il celui qui a été signé ? Son empreinte se calcule ICI, dans le navigateur — il n'est envoyé nulle part. */
export function ComparerEmpreinte({ attendue }: { attendue: string }) {
  const [verdict, setVerdict] = React.useState<"OUI" | "NON" | null>(null);
  return (
    <div className="space-y-1">
      <label htmlFor="pdf-recu" className="block text-xs text-muted-foreground">Comparer avec le PDF que vous avez reçu (le fichier reste sur votre appareil) :</label>
      <input
        id="pdf-recu" type="file" accept="application/pdf" className="block w-full text-xs"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const h = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
          const hex = Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
          setVerdict(hex === attendue ? "OUI" : "NON");
        }}
      />
      {verdict === "OUI" && <p className="rounded-md bg-success/10 px-2 py-1 text-sm font-medium text-success">Identique : ce fichier est bien le bon de commande signé.</p>}
      {verdict === "NON" && <p className="rounded-md bg-destructive/10 px-2 py-1 text-sm font-medium text-destructive">Différent : ce fichier n&apos;est pas le PDF signé (ou c&apos;est une version antérieure à la dernière signature).</p>}
    </div>
  );
}
