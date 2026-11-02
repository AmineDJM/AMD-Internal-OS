/**
 * LE BANC D'AUDIT (décision 0050) — LE JUGEMENT D'UNE TÂCHE, PUR : ce qui a été observé (carte, réponses, questions,
 * compteurs avant / après, fichiers, confirmation) face à ce qui était attendu. Le banc réel l'appelle après chaque tâche ;
 * la suite déterministe l'appelle sur une observation VIDE pour prouver qu'aucune tâche ne réussit sans rien faire.
 */
import type { ObjetAttendu, Tache } from "./types";

export interface Observation {
  carte: { titre: string; champs: string[]; statut: string } | null;
  /** Tout ce que l'assistant a écrit (réponses et blocs). */
  texte: string;
  questions: number;
  avant: Partial<Record<ObjetAttendu, number>>;
  apres: Partial<Record<ObjetAttendu, number>>;
  fichiers: { nom: string; mime: string }[];
  /** Le clic « Confirmer » : null (pas cliqué), « exécutée », ou la raison du refus. */
  confirmation: string | null;
  erreur: string | null;
}

/** Une observation où rien ne s'est passé : aucune réponse, aucune carte, aucun objet, aucun fichier. */
export const OBSERVATION_VIDE: Observation = { carte: null, texte: "", questions: 0, avant: {}, apres: {}, fichiers: [], confirmation: null, erreur: null };

/** Les motifs d'échec (vide : réussie), hors mail, fuites et vérificateur du domaine (jugés à part). */
export function jugerTache(a: Tache["attendu"], o: Observation): string[] {
  const motifs: string[] = [];
  const carte = o.carte;
  const tout = `${o.texte}\n${carte?.champs.join(" ") ?? ""}`;
  if (o.erreur) motifs.push(`tour en erreur : ${o.erreur}`);
  if (a.carte && !carte) motifs.push("aucune carte");
  if (a.carte && carte && !a.carte.test(`${carte.titre} ${carte.champs.join(" ")}`)) motifs.push(`carte inattendue « ${carte.titre} »`);
  for (const [l, v] of a.champs ?? []) if (carte && !carte.champs.some((c) => l.test(c.split(":")[0]!) && v.test(c))) motifs.push(`champ ${l.source} ≠ ${v.source}`);
  for (const [l, v] of a.champsInterdits ?? []) if (carte?.champs.some((c) => l.test(c.split(":")[0]!) && v.test(c))) motifs.push(`champ ${l.source} INVERSÉ (${v.source})`);
  for (const re of a.contient ?? []) if (!re.test(tout)) motifs.push(`manque ${re.source.slice(0, 40)}`);
  for (const re of a.interdit ?? []) if (re.test(tout)) motifs.push(`présent à tort : ${re.source.slice(0, 40)}`);
  if (o.questions > (a.questionsMax ?? 0)) motifs.push(`${o.questions} question(s) avant d'agir (max ${a.questionsMax ?? 0})`);
  if (o.confirmation && o.confirmation !== "exécutée") motifs.push(`confirmation ${o.confirmation}`);
  const n = (x: Partial<Record<ObjetAttendu, number>>, k: ObjetAttendu) => x[k] ?? 0;
  if (a.objet && !(n(o.apres, a.objet) > n(o.avant, a.objet)) && (!a.sansConfirmer || !a.carte)) motifs.push(`aucun objet « ${a.objet} » créé en base`);
  if (a.pasPlusDe && n(o.apres, a.pasPlusDe) > n(o.avant, a.pasPlusDe)) motifs.push(`« ${a.pasPlusDe} » en plus (${n(o.avant, a.pasPlusDe)} → ${n(o.apres, a.pasPlusDe)}) — une 3ᵉ au lieu d'une fusion ?`);
  if (a.fichier && !o.fichiers.some((f) => a.fichier!.test(`${f.nom} ${f.mime}`))) motifs.push("aucun fichier produit");
  if (a.mail && !carte) motifs.push("mail introuvable dans la carte");
  return motifs;
}
