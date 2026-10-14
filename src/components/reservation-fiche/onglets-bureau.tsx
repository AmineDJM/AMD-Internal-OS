import Link from "next/link";

/**
 * LES DEUX ONGLETS DU BUREAU DU SECRÉTARIAT (Direction, 14/10/2026) — « Général » (le tableau validé, inchangé)
 * et « Ad & Pro » (billets, hôtels, BC des postes, devis à retranscrire). Chacun son compteur : rien ne se perd
 * entre deux écrans. L'onglet se MÉMORISE PAR L'URL (`?onglet=adpro`) : un lien de notification l'ouvre, un
 * rafraîchissement le garde.
 */
export function OngletsBureau({ actif, general, adpro }: { actif: "general" | "adpro"; general: number; adpro: number }) {
  const onglet = (cle: "general" | "adpro", href: string, libelle: string, n: number) => (
    <Link
      href={href} role="tab" aria-selected={actif === cle} scroll={false}
      className={`inline-flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${
        actif === cle ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {libelle}
      <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${actif === cle ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"}`}>{n}</span>
    </Link>
  );
  return (
    <div role="tablist" aria-label="Bureau du secrétariat" className="flex gap-1 border-b border-border">
      {onglet("general", "/demandes", "Général", general)}
      {onglet("adpro", "/demandes?onglet=adpro", "Ad & Pro", adpro)}
    </div>
  );
}
