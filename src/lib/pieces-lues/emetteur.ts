import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IDENTITÉ DE L'ÉMETTEUR, RECOPIÉE DU PAPIER — raison sociale, adresse, NIF, RC, RIB, téléphone, e-mail.
 *
 * « Luna lit mal le PDF : le fournisseur et toutes ses infos sont présents, il faut qu'il lise tout » (Direction,
 * 06/10). Un devis imprimait « Raison sociale : SPA PROMBATI HOTEL », son adresse, son NIF, son RC et son RIB, et le
 * bon de commande refusait pourtant de se générer : « le fournisseur de ce devis n'est pas nommé ». L'identité lue
 * ne servait qu'à RECONNAÎTRE une fiche de l'annuaire ; sans fiche, rien n'en restait.
 *
 * Ce module la RECOPIE, sans rien deviner : chaque champ vient d'une ÉTIQUETTE imprimée (« Raison sociale »,
 * « Adresse », « NIF », « Registre de commerce », « RIB », « Tél », « E-mail »), sa valeur étant sur la même ligne
 * ou sur la suivante (les PDF de devis séparent souvent l'étiquette et la valeur). Une étiquette absente laisse le
 * champ VIDE. Les lignes du CLIENT (« Client : … ») ne sont jamais prises pour l'émetteur.
 *
 * Module PUR : aucun import, testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface IdentiteEmetteur {
  nom: string | null;
  adresse: string | null;
  /** Chiffres seulement. */
  nif: string | null;
  rc: string | null;
  /** Chiffres seulement. */
  rib: string | null;
  telephone: string | null;
  email: string | null;
}

export const IDENTITE_VIDE: IdentiteEmetteur = { nom: null, adresse: null, nif: null, rc: null, rib: null, telephone: null, email: null };

type Champ = Exclude<keyof IdentiteEmetteur, "email">;

/** Les étiquettes reconnues, à lire sur le texte SANS accents ni majuscules. L'ordre compte (la plus précise d'abord). */
const ETIQUETTES: { champ: Champ; re: RegExp }[] = [
  { champ: "nom", re: /^(?:raison\s+sociale|denomination(?:\s+sociale)?|nom\s+de\s+l'?entreprise)\s*:?\s*/ },
  { champ: "adresse", re: /^(?:adresse|siege(?:\s+social)?)\s*:?\s*/ },
  { champ: "nif", re: /^(?:n[°o.]?\s*)?(?:n\.?\s?i\.?\s?f\.?|numero\s+d'identification\s+fiscale)\s*:?\s*/ },
  { champ: "rc", re: /^(?:n[°o.]?\s*(?:du\s+)?)?(?:registre\s+(?:du\s+|de\s+)?commerce|r\.?\s?c\.?)\b\s*(?:n[°o.]?)?\s*:?\s*/ },
  { champ: "rib", re: /^(?:r\.?\s?i\.?\s?b\.?|rip)\b\s*(?:n[°o.]?)?\s*:?\s*/ },
  { champ: "telephone", re: /^(?:tel(?:ephone)?|mobile|portable|gsm)\b\.?\s*:?\s*/ },
];

/** Une ligne qui est elle-même une étiquette (vide ou finissant par « : ») ne peut pas être une valeur. */
const estEtiquette = (l: string): boolean => {
  const p = plier(l.trim());
  return p.endsWith(":") || ETIQUETTES.some((e) => e.re.test(p) && p.replace(e.re, "").trim() === "") || /^(client|fax|email|e-mail|site\s+web|date)\b/.test(p);
};

/** Les lignes qui parlent du CLIENT (le destinataire), jamais de l'émetteur. */
const estLigneClient = (p: string) => /^(client|destinataire|facture\s+a|adresse\s+de\s+livraison)\b/.test(p);

function nettoyer(champ: Champ, brut: string): string | null {
  const v = brut.replace(/\s+/g, " ").trim().replace(/^[:\-–\s]+/, "");
  if (!v) return null;
  if (champ === "nif" || champ === "rib") {
    const chiffres = v.replace(/\D/g, "");
    // Un NIF algérien a 15 chiffres (20 avec l'extension) ; un RIB 20. En deçà, ce n'est pas l'identifiant.
    return chiffres.length >= 15 ? chiffres : null;
  }
  if (champ === "telephone") {
    const m = v.match(/[+\d][\d\s().-]{7,}/);
    return m ? m[0].trim() : null;
  }
  return v.slice(0, 200);
}

export function identiteEmetteurDuTexte(texte: string): IdentiteEmetteur {
  const id: IdentiteEmetteur = { ...IDENTITE_VIDE };
  const lignes = texte.split(/\r?\n/);
  for (let i = 0; i < lignes.length; i++) {
    const brute = lignes[i].trim();
    if (!brute) continue;
    const p = plier(brute);
    if (estLigneClient(p)) continue;
    for (const { champ, re } of ETIQUETTES) {
      if (id[champ] !== null) continue;
      const m = p.match(re);
      if (!m) continue;
      // La valeur sur la MÊME ligne (même longueur : le pli ne change pas les positions)…
      let valeur = brute.slice(m[0].length);
      // …sinon sur la ligne suivante, si elle n'est pas elle-même une étiquette.
      if (!valeur.trim()) {
        const suivante = lignes.slice(i + 1).find((x) => x.trim() !== "");
        if (suivante && !estEtiquette(suivante) && !estLigneClient(plier(suivante.trim()))) valeur = suivante;
      }
      const v = nettoyer(champ, valeur);
      if (v) id[champ] = v;
      break;
    }
  }
  // L'e-mail : la première adresse imprimée qui n'est pas sur une ligne du client.
  for (const l of lignes) {
    if (estLigneClient(plier(l.trim()))) continue;
    const m = l.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (m) { id.email = m[0]; break; }
  }
  return id;
}

/** Le papier d'abord (étiquettes imprimées), le modèle ensuite pour ce que le papier n'étiquette pas. */
export function fusionnerIdentite(papier: IdentiteEmetteur, modele: Partial<IdentiteEmetteur> | null | undefined): IdentiteEmetteur {
  const m = modele ?? {};
  return {
    nom: papier.nom ?? m.nom ?? null,
    adresse: papier.adresse ?? m.adresse ?? null,
    nif: papier.nif ?? m.nif ?? null,
    rc: papier.rc ?? m.rc ?? null,
    rib: papier.rib ?? m.rib ?? null,
    telephone: papier.telephone ?? m.telephone ?? null,
    email: papier.email ?? m.email ?? null,
  };
}

/** L'identité porte-t-elle de quoi nommer le fournisseur d'un bon de commande ? */
export const identiteUtilisable = (i: IdentiteEmetteur | null | undefined): i is IdentiteEmetteur => Boolean(i?.nom?.trim());
