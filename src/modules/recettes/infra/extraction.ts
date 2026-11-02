import { prisma } from "@/lib/prisma";
import { ROLE_LABELS } from "@/lib/labels";
import { signatureContenu, type ContenuRecette } from "../domaine/contenu";
import { decisionExtraction, SEUIL_OCCURRENCES_DEFAUT, SEUIL_OCCURRENCES_MIN, statutDeLaRecette, type StatutRecette, type StatutVersion } from "../domaine/etats";
import { extraireRecette, extraireRecetteForme, extraireRecetteTravail } from "../domaine/extraction";
import { decrireCircuit, type Processus } from "../domaine/processus";
import { FENETRE_MOIS, formesValidees, lireCircuits, travauxReussis } from "./sources";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PROPOSER LES RECETTES (J10, décision 0028) — lit les circuits réels, extrait, et ENREGISTRE DES PROPOSITIONS.
 *
 * Idempotent : une façon de faire inchangée (même signature) ne propose rien de neuf ; une proposition en attente se
 * rafraîchit en place ; une recette validée qui a changé reçoit une NOUVELLE version proposée — la validée reste en
 * usage tant que le responsable n'a pas tranché ; une recette retirée ne revient pas d'elle-même. Aucune ligne n'est
 * écrite sous le seuil d'occurrences du processus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BilanExtraction {
  circuits: number;
  creees: number;
  rafraichies: number;
  remplacees: number;
  nouvellesVersions: number;
  sousLeSeuil: number;
}

const libelleRole = (r: string) => ROLE_LABELS[r] ?? r;

export async function seuilsParProcessus(): Promise<Map<string, number>> {
  const lignes = await prisma.recetteResponsable.findMany({ select: { processus: true, seuilOccurrences: true } });
  return new Map(lignes.filter((l) => l.seuilOccurrences !== null).map((l) => [l.processus, Math.max(SEUIL_OCCURRENCES_MIN, l.seuilOccurrences!)]));
}

async function enregistrer(circuit: string, processus: Processus, contenu: ContenuRecette, maintenant: Date, bilan: BilanExtraction): Promise<void> {
  const signature = signatureContenu(contenu);
  await prisma.$transaction(async (tx) => {
    const recette = await tx.recette.findUnique({ where: { circuit }, select: { id: true, statut: true } });
    const derniere = recette
      ? await tx.recetteVersion.findFirst({ where: { recetteId: recette.id }, orderBy: { numero: "desc" }, select: { id: true, numero: true, statut: true, signature: true } })
      : null;
    const d = decisionExtraction(recette ? { statut: recette.statut as StatutRecette } : null, derniere ? { statut: derniere.statut as StatutVersion, signature: derniere.signature } : null, signature);
    const data = { contenu: contenu as never, signature, occurrences: contenu.observation.occurrences };
    if (d === "CREER") {
      if (recette) {
        await tx.recetteVersion.create({ data: { recetteId: recette.id, numero: 1, ...data } });
      } else {
        await tx.recette.create({ data: { circuit, processus, titre: contenu.titre, statut: "PROPOSEE", derniereExtraction: maintenant, versions: { create: { numero: 1, ...data } } } });
      }
      bilan.creees++;
      return;
    }
    if (!recette || !derniere) return;
    if (d === "RAFRAICHIR" || d === "REMPLACER_PROPOSITION") {
      await tx.recetteVersion.update({ where: { id: derniere.id }, data });
      if (d === "RAFRAICHIR") bilan.rafraichies++; else bilan.remplacees++;
    } else if (d === "NOUVELLE_VERSION") {
      await tx.recetteVersion.create({ data: { recetteId: recette.id, numero: derniere.numero + 1, ...data } });
      bilan.nouvellesVersions++;
    }
    const versions = await tx.recetteVersion.findMany({ where: { recetteId: recette.id }, select: { statut: true } });
    await tx.recette.update({
      where: { id: recette.id },
      data: { derniereExtraction: maintenant, statut: statutDeLaRecette(versions as { statut: StatutVersion }[], recette.statut === "RETIREE") },
    });
  });
}

/** Un passage d'extraction complet — tâche de fond `recettes.extraction`, ou le geste « Relire les circuits ». */
export async function proposerLesRecettes(opts: { maintenant?: Date; seuilDefaut?: number } = {}): Promise<BilanExtraction> {
  const maintenant = opts.maintenant ?? new Date();
  const defaut = Math.max(SEUIL_OCCURRENCES_MIN, opts.seuilDefaut ?? SEUIL_OCCURRENCES_DEFAUT);
  const seuils = await seuilsParProcessus();
  const bilan: BilanExtraction = { circuits: 0, creees: 0, rafraichies: 0, remplacees: 0, nouvellesVersions: 0, sousLeSeuil: 0 };
  const seuilDe = (p: Processus) => seuils.get(p) ?? defaut;

  const candidats: { circuit: string; processus: Processus; contenu: ContenuRecette | null }[] = [];
  for (const c of await lireCircuits(maintenant)) {
    const desc = decrireCircuit(c.circuit);
    if (!desc) continue;
    candidats.push({ circuit: c.circuit, processus: desc.processus, contenu: extraireRecette(desc, c.dossiers, c.definition, { seuil: seuilDe(desc.processus), libelleRole }) });
  }
  const depuis = new Date(maintenant.getTime() - FENETRE_MOIS * 30 * 86_400_000);
  for (const [circuit, travaux] of await travauxReussis(depuis, maintenant)) {
    const desc = decrireCircuit(circuit);
    if (desc) candidats.push({ circuit, processus: desc.processus, contenu: extraireRecetteTravail(desc, travaux, { seuil: seuilDe(desc.processus) }) });
  }
  for (const f of await formesValidees(depuis, maintenant)) {
    const desc = decrireCircuit(f.circuit);
    if (desc) candidats.push({ circuit: f.circuit, processus: desc.processus, contenu: extraireRecetteForme(desc, f, { seuil: seuilDe(desc.processus) }) });
  }

  for (const c of candidats) {
    bilan.circuits++;
    if (!c.contenu) { bilan.sousLeSeuil++; continue; }
    await enregistrer(c.circuit, c.processus, c.contenu, maintenant, bilan);
  }
  return bilan;
}
