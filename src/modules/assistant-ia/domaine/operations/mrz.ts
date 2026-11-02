/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA ZONE MRZ D'UN PASSEPORT (ICAO 9303, format TD3 : deux lignes de 44 caractères) — lue ICI.
 *
 * Module pur : il reçoit le texte de l'OCR LOCAL et rend les champs, avec les chiffres de contrôle
 * vérifiés. Aucun de ces champs ne part au modèle : ils vont sur la carte (que seule la personne
 * voit) puis dans l'ERP. Un chiffre de contrôle faux n'est pas « corrigé » : il est DIT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PasseportLu {
  nom: string;
  prenoms: string;
  numero: string;
  pays: string;
  nationalite: string;
  /** ISO AAAA-MM-JJ. */
  naissance: string | null;
  sexe: "M" | "F" | null;
  /** ISO AAAA-MM-JJ. */
  expiration: string | null;
  /** Les contrôles qui ont échoué (numéro, naissance, expiration, global) — vide : tout est cohérent. */
  controlesFaux: string[];
}

const POIDS = [7, 3, 1];

export function chiffreDeControle(s: string): number {
  let somme = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const v = c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c >= "A" && c <= "Z" ? c.charCodeAt(0) - 55 : 0;
    somme += v * POIDS[i % 3]!;
  }
  return somme % 10;
}

/** Les confusions ordinaires de l'OCR sur la police OCR-B — appliquées aux seules positions NUMÉRIQUES. */
const VERS_CHIFFRE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const chiffres = (s: string) => s.replace(/[OQDILZSBG]/g, (c) => VERS_CHIFFRE[c] ?? c);

function dateMrz(aammjj: string, futur: boolean): string | null {
  if (!/^\d{6}$/.test(aammjj)) return null;
  const aa = Number(aammjj.slice(0, 2));
  const mm = Number(aammjj.slice(2, 4));
  const jj = Number(aammjj.slice(4, 6));
  if (mm < 1 || mm > 12 || jj < 1 || jj > 31) return null;
  const siecle = new Date().getUTCFullYear() % 100;
  // Une expiration est dans le futur proche (siècle courant) ; une naissance, jamais après l'année en cours.
  const annee = futur ? 2000 + aa : aa > siecle ? 1900 + aa : 2000 + aa;
  return `${annee}-${String(mm).padStart(2, "0")}-${String(jj).padStart(2, "0")}`;
}

const nomsDe = (champ: string) => champ.replace(/<+$/, "").split("<").filter(Boolean).join(" ").trim();

/** Normalise une ligne lue par l'OCR : majuscules, sans espaces, chevrons reconnus sous leurs déguisements. */
function normaliser(l: string): string {
  return l.toUpperCase().replace(/[«‹＜]/g, "<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, "");
}

export function lireMrz(texte: string): PasseportLu | null {
  const lignes = texte.split(/\r?\n/).map(normaliser).filter((l) => l.length >= 30);
  for (let i = 0; i < lignes.length - 1; i++) {
    const l1 = lignes[i]!;
    if (!/^P[A-Z<]/.test(l1) || (l1.match(/</g)?.length ?? 0) < 3) continue;
    const l2 = lignes[i + 1]!.padEnd(44, "<").slice(0, 44);
    const un = l1.padEnd(44, "<").slice(0, 44);
    const [nomBrut, ...prenomsBruts] = un.slice(5).split("<<");
    const numero = l2.slice(0, 9);
    const cNum = chiffres(l2[9]!);
    const naissance = chiffres(l2.slice(13, 19));
    const cNai = chiffres(l2[19]!);
    const expiration = chiffres(l2.slice(21, 27));
    const cExp = chiffres(l2[27]!);
    const controlesFaux: string[] = [];
    if (String(chiffreDeControle(numero)) !== cNum) controlesFaux.push("numéro du passeport");
    if (String(chiffreDeControle(naissance)) !== cNai) controlesFaux.push("date de naissance");
    if (String(chiffreDeControle(expiration)) !== cExp) controlesFaux.push("date d'expiration");
    const composite = l2.slice(0, 10) + naissance + cNai + expiration + cExp + l2.slice(28, 43);
    if (/\d/.test(l2[43]!) && String(chiffreDeControle(composite)) !== l2[43]) controlesFaux.push("contrôle global");
    const nom = nomsDe(nomBrut ?? "");
    if (!nom) continue;
    return {
      nom,
      prenoms: nomsDe(prenomsBruts.join("<<")),
      numero: numero.replace(/<+$/, ""),
      pays: un.slice(2, 5).replace(/</g, ""),
      nationalite: l2.slice(10, 13).replace(/</g, ""),
      naissance: dateMrz(naissance, false),
      sexe: l2[20] === "M" || l2[20] === "F" ? l2[20] : null,
      expiration: dateMrz(expiration, true),
      controlesFaux,
    };
  }
  return null;
}

/** « BENALI » → « Benali », « MOHAMED AMINE » → « Mohamed Amine » — l'écriture de la fiche. */
export function casse(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}
