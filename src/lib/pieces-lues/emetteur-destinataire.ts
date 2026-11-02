import { cleSociete } from "@/lib/quality/model";
import { plier } from "@/lib/utils";
import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI ÉMET LE DEVIS, À QUI IL EST ADRESSÉ (lot B1, décision 0049). Pur.
 *
 * Mesuré le 02/11 : sur le devis INSIGNE, le bon de commande composé imprimait « Fournisseur :
 * ADVENTUM PHARMA ». Deux causes, toutes deux du papier mal lu :
 *   1. le BLOC CLIENT d'un devis (« Client : / ADVENTUM PHARMA / NIF : 0016… / RC : … ») porte
 *      des étiquettes NIF et RC — et la lecture des étiquettes, qui n'écartait que la ligne
 *      commençant par « Client », prenait le NIF et le RC du CLIENT pour ceux de l'émetteur ;
 *   2. le nom du fournisseur venait du modèle, qui l'avait pris au même endroit.
 *
 * La règle : le FOURNISSEUR est l'ÉMETTEUR — l'en-tête (logo, raison sociale), le pied de page qui
 * répète « NOM — RC … — NIF … — NIS … — AI … », le nom du fichier (« Devis … INSIGNE.pdf »).
 * Le CLIENT est une société du GROUPE (Adventum Pharma, Pharmagène, AMD Life Sciences) — jamais
 * l'inverse : une société du groupe n'est JAMAIS le fournisseur retenu, par son nom, son NIF ou son RC.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SocieteDuGroupe {
  id: string;
  /** Nom d'usage, libellé court, dénomination légale. */
  noms: readonly (string | null | undefined)[];
  nifs: readonly (string | null | undefined)[];
  rcs: readonly (string | null | undefined)[];
}

export interface EmetteurLu {
  nom: string | null;
  nif: string | null;
  rc: string | null;
  nis: string | null;
  ai: string | null;
  /** D'où vient le nom — « pied de page », « en-tête », « nom du fichier »… */
  source: string | null;
}

export interface DestinataireLu {
  societeId: string;
  par: "NIF" | "RC" | "NOM";
}

export interface ResultatEmetteurDestinataire {
  emetteur: EmetteurLu;
  /** La société du groupe destinataire — `null` : aucune lue, `ambigu` : plusieurs. */
  destinataire: DestinataireLu | null;
  destinatairesPossibles: string[];
  /** Les lignes du texte qui appartiennent au bloc du client (indices 0-based) — jamais lues comme émetteur. */
  zoneClient: Set<number>;
}

const RE_TETE_CLIENT = /^(client|destinataire|doit|facture\s+a|factur[eé]\s+a|adress[eé]\s+a|a\s+l'?attention\s+de|livre\s+a|adresse\s+de\s+livraison|bill\s+to|customer|ste\s+cliente)\b/;
/** Ce qui ferme le bloc client : une autre rubrique. */
const RE_FIN_CLIENT = /^(objet|n[°o]|designation|date|devis|reference|ref\b|conditions|validite|page)\b/;

/** Les lignes du BLOC CLIENT : l'intitulé, puis jusqu'à six lignes, jusqu'à une ligne vide ou une autre rubrique. */
export function zoneDuClient(lignes: readonly string[]): Set<number> {
  const zone = new Set<number>();
  for (let i = 0; i < lignes.length; i++) {
    const p = plier(lignes[i].trim()).replace(/\s*\|\s*/g, " ");
    if (!RE_TETE_CLIENT.test(p)) continue;
    zone.add(i);
    for (let j = i + 1, n = 0; j < lignes.length && n < 6; j++) {
      const q = plier(lignes[j].trim());
      if (!q) { if (n > 0) break; continue; }
      if (RE_FIN_CLIENT.test(q)) break;
      zone.add(j);
      n++;
    }
  }
  return zone;
}

const MOTS_FICHIER = new Set([
  "devis", "proforma", "pro", "forma", "facture", "offre", "bon", "commande", "bc", "pdf", "scan", "scanne", "materiel", "promotionnel",
  "promo", "de", "du", "des", "la", "le", "les", "pour", "et", "n", "no", "num", "final", "v1", "v2", "copie", "signe", "doc", "document",
  "congres", "objets", "objet", "image", "photo", "img", "def", "definitif",
]);

/** Le nom de l'émetteur tel que le NOM DU FICHIER le porte (« Devis matériel promotionnel INSIGNE.pdf » → « INSIGNE »). */
export function nomDuFichier(nomFichier: string): string | null {
  const base = nomFichier.replace(/\.[a-z0-9]{2,5}$/i, "");
  const mots = base.split(/[\s_\-.]+/).filter(Boolean);
  // Les mots en CAPITALES qui ne sont ni des mots du métier ni des numéros : le nom de la société.
  const capitales = mots.filter((m) => /^[A-Z][A-Z0-9&']{1,}$/.test(m) && !MOTS_FICHIER.has(plier(m)) && !/^\d/.test(m));
  return capitales.length ? capitales.join(" ") : null;
}

/** La clé de comparaison d'un nom de société : sans forme juridique, sans accents, sans ponctuation. */
const cle = (s: string | null | undefined) => cleSociete(s ?? "");

/** Le nom désigne-t-il une société du groupe ? Égalité de clé, ou la clé de l'une contient l'autre (« ADVENTUM PHARMA SPA », « Adventum »). */
export function estDuGroupe(nom: string | null | undefined, groupe: readonly SocieteDuGroupe[]): SocieteDuGroupe | null {
  const k = cle(nom);
  if (!k || k.length < 3) return null;
  for (const s of groupe) {
    for (const n of s.noms) {
      const g = cle(n);
      if (!g || g.length < 3) continue;
      if (k === g || ` ${k} `.includes(` ${g} `) || ` ${g} `.includes(` ${k} `)) return s;
    }
  }
  return null;
}

/** Le pied de page d'un émetteur algérien : « NOM — RC … — NIF … » (ou « NOM | RC … »), le nom avant le premier séparateur. */
function nomDuPied(ligne: string): string | null {
  const p = plier(ligne);
  if (!/\b(r\.?\s?c|nif|n\.?i\.?f)\b/.test(p)) return null;
  const m = /^\s*([^—–|,:;]{2,60}?)\s*(?:[—–|,;]|\s-\s)/.exec(ligne);
  if (!m) return null;
  const nom = m[1].trim();
  if (/^(r\.?\s?c|nif|nis|ai|n[°o]|tel|adresse|capital|siege|sarl au capital)/i.test(plier(nom))) return null;
  return /[a-z]/i.test(nom) ? nom : null;
}

/** Une ligne d'en-tête qui peut être une raison sociale : des lettres, courte, pas une rubrique. */
function nomDEnTete(ligne: string): string | null {
  const t = ligne.split("|")[0].trim();
  if (t.length < 2 || t.length > 60) return null;
  const p = plier(t);
  if (/^(devis|facture|proforma|bon de commande|date|page|tel|fax|email|e-mail|adresse|objet|client|n[°o]|ref|www\.|http|rc\b|nif\b|nis\b|ai\b|capital)/.test(p)) return null;
  if (/\d{3,}/.test(t) || /@/.test(t)) return null;
  // Une raison sociale d'en-tête s'imprime en capitales (ou porte une forme juridique).
  const lettres = t.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (lettres.length < 2) return null;
  const capitales = lettres.replace(/[^A-ZÀ-Ý]/g, "").length / lettres.length;
  return capitales >= 0.8 || /\b(sarl|spa|eurl|snc|ets|etablissements?)\b/.test(p) ? t : null;
}

export function emetteurEtDestinataire(args: {
  texte: string;
  nomFichier: string;
  groupe: readonly SocieteDuGroupe[];
  /** Le nom que le modèle a lu comme fournisseur — retenu seulement s'il n'est pas du groupe et qu'aucune lecture du papier ne nomme mieux. */
  nomModele?: string | null;
  /** La raison sociale étiquetée (« Raison sociale : … ») lue hors du bloc client. */
  nomEtiquete?: string | null;
}): ResultatEmetteurDestinataire {
  const lignes = args.texte.split(/\r?\n/);
  const zone = zoneDuClient(lignes);
  const nifsGroupe = new Set(args.groupe.flatMap((s) => s.nifs.map(normaliserNif)).filter((x): x is string => !!x));
  const rcsGroupe = new Set(args.groupe.flatMap((s) => s.rcs.map(normaliserRc)).filter((x): x is string => !!x));

  // ── LE DESTINATAIRE : la société du groupe que le papier nomme (bloc client d'abord), par NIF, RC ou nom.
  const trouves = new Map<string, DestinataireLu["par"]>();
  const ordre = [...zone, ...lignes.keys()];
  const vues = new Set<number>();
  for (const i of ordre) {
    if (vues.has(i)) continue;
    vues.add(i);
    const l = lignes[i];
    for (const s of args.groupe) {
      if (trouves.has(s.id)) continue;
      const chiffres = l.replace(/\D/g, "");
      if (s.nifs.some((n) => { const k = normaliserNif(n); return k && chiffres.includes(k); })) { trouves.set(s.id, "NIF"); continue; }
      const rcLigne = l.toUpperCase().replace(/[^0-9A-Z]/g, "");
      if (s.rcs.some((r) => { const k = normaliserRc(r); return k && k.length >= 8 && rcLigne.includes(k); })) { trouves.set(s.id, "RC"); continue; }
      const k = ` ${cle(l)} `;
      if (s.noms.some((n) => { const g = cle(n); return g.length >= 4 && k.includes(` ${g} `); })) trouves.set(s.id, "NOM");
    }
  }
  // Dans le bloc client, la société nommée l'emporte ; ailleurs (une mention « logo Adventum » dans une désignation), elle compte moins.
  const dansZone = [...trouves.keys()].filter((id) => {
    const s = args.groupe.find((g) => g.id === id)!;
    return [...zone].some((i) => estDuGroupe(lignes[i], [s]) !== null || s.nifs.some((n) => { const k = normaliserNif(n); return k && lignes[i].replace(/\D/g, "").includes(k); }));
  });
  const possibles = dansZone.length ? dansZone : [...trouves.keys()];
  // Un identifiant l'emporte sur un nom : le NIF, puis le RC, puis le nom seul.
  const parForce = (["NIF", "RC", "NOM"] as const).map((par) => possibles.filter((id) => trouves.get(id) === par)).find((xs) => xs.length > 0) ?? [];
  const destinataire = parForce.length === 1 ? { societeId: parForce[0], par: trouves.get(parForce[0])! } : null;

  // ── L'ÉMETTEUR : ses identifiants hors bloc client et hors groupe ; son nom par la source la plus sûre.
  const horsZone = lignes.map((l, i) => (zone.has(i) ? "" : l));
  const idents = (re: RegExp, norm: (s: string) => string | null, exclus: Set<string>, garderImprime = false) => {
    for (const l of horsZone) {
      const m = re.exec(plier(l));
      if (!m) continue;
      const brut = l.slice(m.index + m[0].length).split(/[—–|;]|\s-\s/)[0];
      const imprime = brut.replace(/^[\s:]+/, "").replace(/\s+/g, " ").trim();
      const v = norm(imprime);
      // Comparé normalisé, rendu TEL QU'IMPRIMÉ (« 16/00-0987654 B 12 ») — le BC le recopie.
      if (v && !exclus.has(v)) return garderImprime ? imprime.slice(0, 40) : v;
    }
    return null;
  };
  const nif = idents(/\b(?:n[°o.]?\s*)?(?:n\.?\s?i\.?\s?f\.?)\s*:?/, (s) => normaliserNif(s.replace(/\s+/g, "").slice(0, 25)), nifsGroupe);
  const rc = idents(/\b(?:n[°o.]?\s*)?(?:r\.?\s?c\.?|registre\s+(?:du\s+)?commerce)\b\s*(?:n[°o]?)?\s*:?/, (s) => normaliserRc(s.slice(0, 30)), rcsGroupe, true);
  const brutIdent = (re: RegExp) => {
    for (const l of horsZone) {
      const m = re.exec(plier(l));
      if (m) { const v = l.slice(m.index + m[0].length).split(/[—–|;]|\s-\s/)[0].replace(/\D/g, ""); if (v.length >= 8) return v; }
    }
    return null;
  };
  const nis = brutIdent(/\bn\.?\s?i\.?\s?s\.?\b\s*:?/);
  const ai = brutIdent(/\b(?:a\.?\s?i\.?|art(?:icle)?\.?\s*(?:d'?\s*)?imp(?:osition)?\.?)\b\s*:?/);

  const candidats: { nom: string | null; source: string }[] = [
    { nom: args.nomEtiquete ?? null, source: "raison sociale imprimée" },
    ...horsZone.map((l) => ({ nom: nomDuPied(l), source: "pied de page" })),
    ...horsZone.slice(0, 15).map((l) => ({ nom: nomDEnTete(l), source: "en-tête" })),
    { nom: args.nomModele ?? null, source: "lecture du devis" },
    { nom: nomDuFichier(args.nomFichier), source: "nom du fichier" },
  ];
  const fichier = cle(nomDuFichier(args.nomFichier));
  const retenu = candidats.find((c) => c.nom && c.nom.trim() && !estDuGroupe(c.nom, args.groupe) && !RE_TETE_CLIENT.test(plier(c.nom.trim())));
  // Le nom du fichier CONFIRME : si l'en-tête porte une ligne qui contient le nom du fichier, c'est elle.
  const confirme = fichier ? candidats.find((c) => c.source !== "nom du fichier" && c.nom && ` ${cle(c.nom)} `.includes(` ${fichier} `) && !estDuGroupe(c.nom, args.groupe)) : null;
  const choisi = confirme ?? retenu ?? null;
  return {
    emetteur: { nom: choisi?.nom?.trim() ?? null, nif, rc, nis, ai, source: choisi?.source ?? null },
    destinataire,
    destinatairesPossibles: possibles,
    zoneClient: zone,
  };
}
