/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BC SIGNÉ SUR PAPIER, ET LA FACTURE QUI LE SUIT (Direction, 06/10) — les règles PURES.
 *
 * « Quand les Finances uploadent le BC signé, ça doit être obligatoire, avec mention du signataire, depuis
 * leur module "Bons de commande". Luna confirme que la signature est repérée ; il remplace le BC non signé
 * dans Ad&Pro, et la case Facture se débloque. Une fois la facture reçue, Luna vérifie uniquement la
 * cohérence avec le BC : si c'est bon, la demande de paiement se déclenche ; s'il y a des incohérences
 * (notamment le montant total), on demande une argumentation, et la demande ne part que s'il coche oui.
 * Ça doit aussi fonctionner avec plusieurs BC. »
 *
 * Aucun import : l'écran (client) lit les mêmes phrases que l'action (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'étape du `Document` qui porte la copie signée d'un BC. */
export const ETAPE_COPIE_SIGNEE = "BC_SIGNE";

/** Les formats d'une copie signée : un scan (PDF) ou une photo. */
export const FORMATS_COPIE_SIGNEE = ["pdf", "png", "jpg", "jpeg", "webp"] as const;

/** Ce que Luna a vu sur la copie. `NON_VERIFIEE` : Luna n'a pas pu regarder (IA coupée, clé absente, format, panne). */
export interface VerdictSignature {
  statut: "REPEREE" | "ABSENTE" | "NON_VERIFIEE";
  signature: boolean;
  cachet: boolean;
  /** Le numéro du bon de commande imprimé sur la copie, tel que Luna le lit. */
  numeroLu: string | null;
  /** Ce que Luna dit avoir vu, ou pourquoi elle n'a pas regardé — notre phrase, jamais le document. */
  note: string;
}

const alnum = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * LE VERDICT DE LUNA, LU EN RÈGLE : une copie où Luna ne voit AUCUNE signature est refusée ; une copie dont le
 * numéro lu est celui d'un AUTRE bon de commande aussi (on signerait le mauvais). Luna indisponible ne bloque
 * pas les Finances — la signature est alors enregistrée « non vérifiée par Luna », et l'écran le dit.
 */
export function refusCopieSignee(v: VerdictSignature, reference: string | null): string | null {
  if (v.statut === "ABSENTE") {
    return `Luna ne repère aucune signature au bas de ce bon de commande${v.note ? ` (${v.note.replace(/[.\s]+$/, "")})` : ""}. Téléversez la copie SIGNÉE — scan ou photo nette de la page signée.`;
  }
  const ref = reference?.trim() ? alnum(reference) : "";
  const lu = v.numeroLu ? alnum(v.numeroLu) : "";
  if (ref && lu && lu.length >= 4 && !lu.includes(ref) && !ref.includes(lu)) {
    return `Cette copie porte le numéro ${v.numeroLu}, pas ${reference} : ce n'est pas ce bon de commande.`;
  }
  return null;
}

/** La phrase qui confirme la signature — dite aux Finances, et sur la case du poste. */
export function phraseVerdictSignature(v: VerdictSignature): string {
  if (v.statut === "NON_VERIFIEE") return `Signature non vérifiée par Luna (${v.note.replace(/[.\s]+$/, "")}).`;
  const vus = [v.signature ? "signature" : null, v.cachet ? "cachet" : null].filter(Boolean).join(" et ");
  return `Luna repère ${vus || "une signature"} au bas du bon de commande.`;
}

/** Relit un verdict gardé en base (JSON) — `null` s'il n'a pas la forme attendue. */
export function verdictSignatureDe(json: unknown): VerdictSignature | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (o.statut !== "REPEREE" && o.statut !== "ABSENTE" && o.statut !== "NON_VERIFIEE") return null;
  return {
    statut: o.statut, signature: o.signature === true, cachet: o.cachet === true,
    numeroLu: typeof o.numeroLu === "string" ? o.numeroLu : null, note: typeof o.note === "string" ? o.note : "",
  };
}

// ───────────────────────── La facture contre le(s) bon(s) de commande ─────────────────────────

/** La tolérance d'un dinar — celle de la retranscription des pièces (§118.59). */
export const TOLERANCE_DZD = 1;

/** Ce qu'on a lu (ou saisi) de la facture. */
export interface FactureLue {
  /** Le total TTC imprimé (ou le net à payer) — `null` s'il ne s'est pas lu. */
  montantLu: number | null;
  /** Le montant saisi par la personne, quand elle en a donné un. */
  montantSaisi: number | null;
  /** Les numéros de BC que la facture cite (« suivant BC N° … »). */
  bcCites: string[];
  /** Le nom de l'émetteur lu sur la facture. */
  fournisseurLu: string | null;
  /** Comment la facture a été lue — notre phrase. */
  methode: string;
}

export interface BcControle {
  id: string;
  reference: string | null;
  montantTtc: number | null;
  fournisseur: string | null;
}

/** LE CONTRÔLE D'UNE FACTURE CONTRE LE(S) BC QU'ELLE COUVRE — gardé sur la facture, lu par la case paiement. */
export interface ControleFacture {
  bcIds: string[];
  /** Le montant retenu pour la facture : le lu, sinon le saisi. */
  montant: number | null;
  montantBcs: number | null;
  coherente: boolean;
  /** Les incohérences, en phrases — vides quand elle est cohérente. */
  ecarts: string[];
  methode: string;
}

const dzd = (n: number): string => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DZD`;

/** Deux noms de société se recoupent-ils ? (un mot significatif commun suffit : « SARL Imprimerie El Djazair » / « IMPRIMERIE EL DJAZAIR »). */
function memeSociete(a: string, b: string): boolean {
  const VIDES = new Set(["SARL", "EURL", "SPA", "SNC", "ETS", "STE", "SOCIETE", "ENTREPRISE", "LES", "DES", "DU", "DE", "LA", "LE", "ET", "EL"]);
  const mots = (s: string) => new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter((m) => m.length >= 3 && !VIDES.has(m)));
  const ma = mots(a);
  const mb = mots(b);
  if (ma.size === 0 || mb.size === 0) return true;
  for (const m of ma) if (mb.has(m)) return true;
  return false;
}

/**
 * LA COHÉRENCE DE LA FACTURE AVEC SES BC — « uniquement la cohérence avec le bon de commande » :
 *   • le MONTANT TOTAL : le total lu (sinon saisi) égale la somme TTC des BC couverts, à un dinar près ;
 *   • le montant lu et le montant saisi, quand il y a les deux, disent la même chose ;
 *   • les BC CITÉS par la facture, quand elle en cite, sont bien ceux qu'elle couvre ;
 *   • le FOURNISSEUR lu est celui des BC.
 * Un montant qui ne se lit pas et n'est pas saisi est une incohérence (on ne paie pas un montant inconnu).
 */
export function controlerFacture(f: FactureLue, bcs: readonly BcControle[]): ControleFacture {
  const ecarts: string[] = [];
  const montant = f.montantLu ?? f.montantSaisi;
  const connus = bcs.filter((b) => b.montantTtc != null);
  const montantBcs = connus.length === bcs.length && bcs.length > 0
    ? Math.round(connus.reduce((s, b) => s + (b.montantTtc as number) * 100, 0)) / 100
    : null;
  const noms = bcs.map((b) => b.reference ?? "sans numéro").join(", ");
  if (montant == null) ecarts.push("Le montant total de la facture ne se lit pas, et aucun montant n'a été saisi.");
  else if (montantBcs == null) ecarts.push(`Le montant du bon de commande (${noms}) n'est pas connu : la facture ne peut pas lui être comparée.`);
  else if (Math.abs(montant - montantBcs) > TOLERANCE_DZD) {
    ecarts.push(`Montant total : la facture fait ${dzd(montant)}, ${bcs.length > 1 ? `les bons de commande ${noms} font` : `le bon de commande ${noms} fait`} ${dzd(montantBcs)} (écart de ${dzd(Math.round((montant - montantBcs) * 100) / 100)}).`);
  }
  if (f.montantLu != null && f.montantSaisi != null && Math.abs(f.montantLu - f.montantSaisi) > TOLERANCE_DZD) {
    ecarts.push(`Luna lit ${dzd(f.montantLu)} sur la facture, le montant saisi est ${dzd(f.montantSaisi)}.`);
  }
  if (f.bcCites.length > 0) {
    const refs = bcs.map((b) => (b.reference ? alnum(b.reference) : "")).filter(Boolean);
    const cites = f.bcCites.map(alnum).filter((c) => c.length >= 4);
    const inconnus = f.bcCites.filter((_, i) => cites[i] && !refs.some((r) => r.includes(cites[i]) || cites[i].includes(r)));
    if (refs.length > 0 && inconnus.length > 0 && inconnus.length === f.bcCites.length) {
      ecarts.push(`La facture cite le bon de commande ${inconnus.join(", ")}, pas ${noms}.`);
    }
  }
  const fournisseurs = [...new Set(bcs.map((b) => b.fournisseur?.trim()).filter((n): n is string => Boolean(n)))];
  if (f.fournisseurLu && fournisseurs.length > 0 && !fournisseurs.some((n) => memeSociete(n, f.fournisseurLu as string))) {
    ecarts.push(`La facture est émise par ${f.fournisseurLu}, le bon de commande est au nom de ${fournisseurs.join(", ")}.`);
  }
  return { bcIds: bcs.map((b) => b.id), montant, montantBcs, coherente: ecarts.length === 0, ecarts, methode: f.methode };
}

/** Relit un contrôle gardé en base (JSON) — `null` s'il n'a pas la forme attendue. */
export function controleFactureDe(json: unknown): ControleFacture | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.bcIds) || typeof o.coherente !== "boolean") return null;
  return {
    bcIds: o.bcIds.filter((x): x is string => typeof x === "string"),
    montant: typeof o.montant === "number" ? o.montant : null,
    montantBcs: typeof o.montantBcs === "number" ? o.montantBcs : null,
    coherente: o.coherente,
    ecarts: Array.isArray(o.ecarts) ? o.ecarts.filter((x): x is string => typeof x === "string") : [],
    methode: typeof o.methode === "string" ? o.methode : "",
  };
}

/**
 * LA DEMANDE DE PAIEMENT D'UN POSTE À BC — ce qui la retient encore, ou `null` : elle peut partir.
 * Tous les BC vivants signés, chacun couvert par une facture ; une facture incohérente exige l'argumentation
 * ET la confirmation (« s'il coche oui »).
 */
export function refusDemandePaiementBC(a: {
  bcs: readonly { id: string; reference: string | null; signe: boolean }[];
  factures: readonly { controle: ControleFacture | null }[];
  argumentation: string | null;
  confirme: boolean;
}): string | null {
  if (a.bcs.length === 0) return "Le bon de commande de ce poste n'est pas encore établi : la facture se dépose après lui.";
  const nonSignes = a.bcs.filter((b) => !b.signe);
  if (nonSignes.length > 0) return `Le bon de commande ${nonSignes.map((b) => b.reference ?? "sans numéro").join(", ")} n'est pas encore signé : la facture se dépose après la signature.`;
  const couverts = new Set(a.factures.flatMap((f) => f.controle?.bcIds ?? []));
  const sansFacture = a.bcs.filter((b) => !couverts.has(b.id));
  if (sansFacture.length > 0) return `Déposez la facture du bon de commande ${sansFacture.map((b) => b.reference ?? "sans numéro").join(", ")} : le paiement couvre tout ce qui a été commandé.`;
  const incoherentes = a.factures.filter((f) => f.controle && !f.controle.coherente);
  if (incoherentes.length > 0) {
    if (!a.argumentation?.trim()) return `La facture n'est pas cohérente avec le bon de commande (${incoherentes.flatMap((f) => f.controle!.ecarts).join(" ")}) : expliquez pourquoi le paiement doit tout de même partir.`;
    if (!a.confirme) return "Cochez « Oui, je souhaite quand même faire la demande de paiement » pour la faire partir malgré l'écart.";
  }
  return null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NON RETENUS D'UN POSTE — les règles PURES (Direction, 11/2026).
 *
 * Quand le BC d'un poste est SIGNÉ (page Bons de commande), chaque devis du poste sans ligne validée est marqué « non
 * retenu » : la trace de l'offre écartée reste au registre, avec qui a validé celle qui l'a emporté. L'écriture et la
 * lecture vivent dans `bons-de-commande/non-retenus.ts`.
 *
 * Aucun import lourd : l'écran (client) lit les mêmes phrases que l'action (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un devis du poste, tel que le marquage « non retenu » le lit. */
export interface DevisPourRetenue {
  pieceId: string;
  /** Lignes validées pour CE poste. */
  nbValidees: number;
  annule: boolean;
}

/**
 * LES DEVIS NON RETENUS d'un poste, au dépôt de son BC signé : ceux qui comptent (non annulés) et n'ont AUCUNE ligne validée
 * pour ce poste. Le devis retenu, et tout devis qui porte une ligne validée (un autre BC du même poste), n'y sont jamais.
 */
export function devisNonRetenus(devis: readonly DevisPourRetenue[]): string[] {
  return devis.filter((d) => !d.annule && d.nbValidees === 0).map((d) => d.pieceId);
}

/** Le libellé « non retenu » d'un devis, dit sur le poste et dans Legal. */
export function libelleNonRetenu(le: Date | string, par: string | null): string {
  const d = typeof le === "string" ? new Date(le) : le;
  const date = Number.isNaN(d.getTime()) ? "" : ` le ${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" })}`;
  return `Non retenu${date}${par ? ` — offre retenue validée par ${par}` : ""}`;
}
