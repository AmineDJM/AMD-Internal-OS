/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TRANCHER UN DOUBLON PROPOSÉ — fusionner, écarter, défaire (lot V2-B). Le geste est HUMAIN et TRACÉ :
 * l'action qui l'appelle vérifie qui tranche et écrit l'audit ; ici, les écritures, dans une transaction.
 *
 * FUSIONNER A dans B (B est gardée) :
 *   • les lignes des neuf tables qui portaient A portent B ; leurs références sont gardées sur la
 *     proposition (`deplacees`) — de quoi défaire la fusion ;
 *   • affiliations, adresses, points de contact et pièces liées à A passent à B (une pièce déjà liée à B
 *     avec le même rôle reste sur A : le lien existe déjà) ;
 *   • B gagne les rôles en cours de A et COMPLÈTE ses champs vides avec ceux de A (jamais d'écrasement) ;
 *   • A n'est pas effacée : elle porte `fusionneeDansId = B`, et tout ce qui la désigne encore la suit.
 *
 * DÉFAIRE : les lignes déplacées qui portent toujours B reviennent à A, A n'est plus fusionnée, la
 * proposition redevient « PROPOSE ». Les rôles et compléments acquis par B restent (ils sont vrais de la
 * personne que B désigne, ou se corrigent sur sa fiche).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { assurerRole, delegue, type Db } from "./rattachement";
import { SOURCES_PERSONNE, complements, completude, estSourcePersonne, refDe } from "./sources";

export class RefusFusionPersonne extends Error {}

async function chargerProposition(db: Db, doublonId: string) {
  const d = await db.doublonPersonne.findUnique({ where: { id: doublonId } });
  if (!d) throw new RefusFusionPersonne("Proposition introuvable.");
  return d;
}

export async function fusionnerPersonnes(db: Db, p: { doublonId: string; gardeeId: string; parId: string }): Promise<{ absorbeeId: string; deplacees: string[] }> {
  const d = await chargerProposition(db, p.doublonId);
  if (d.statut !== "PROPOSE") throw new RefusFusionPersonne("Cette proposition a déjà été tranchée.");
  if (p.gardeeId !== d.personneAId && p.gardeeId !== d.personneBId) throw new RefusFusionPersonne("La Personne gardée doit être l'une des deux.");
  const absorbeeId = p.gardeeId === d.personneAId ? d.personneBId : d.personneAId;

  const [gardee, absorbee] = await Promise.all([
    db.personne.findUnique({ where: { id: p.gardeeId } }),
    db.personne.findUnique({ where: { id: absorbeeId }, include: { roles: { where: { jusquA: null }, select: { role: true } } } }),
  ]);
  if (!gardee || !absorbee) throw new RefusFusionPersonne("Personne introuvable.");
  if (gardee.fusionneeDansId || absorbee.fusionneeDansId) {
    throw new RefusFusionPersonne("L'une des deux Personnes a déjà été fusionnée ailleurs : relancez la reprise des doublons.");
  }

  // Les lignes sources.
  const deplacees: string[] = [];
  for (const source of SOURCES_PERSONNE) {
    const t = delegue(db, source);
    const lignes = await t.findMany({ where: { personneId: absorbeeId }, select: { id: true } });
    if (!lignes.length) continue;
    await t.updateMany({ where: { personneId: absorbeeId }, data: { personneId: p.gardeeId } });
    deplacees.push(...lignes.map((l) => refDe(source, String(l.id))));
  }
  // Ce que le référentiel rattache à la Personne.
  await db.affiliation.updateMany({ where: { personneId: absorbeeId }, data: { personneId: p.gardeeId } });
  await db.adresse.updateMany({ where: { personneId: absorbeeId }, data: { personneId: p.gardeeId } });
  await db.pointDeContact.updateMany({ where: { personneId: absorbeeId }, data: { personneId: p.gardeeId } });
  await db.$executeRaw`
    UPDATE "PieceLien" pl SET "sujetId" = ${p.gardeeId}
    WHERE pl."sujetType" = 'PERSONNE' AND pl."sujetId" = ${absorbeeId}
      AND NOT EXISTS (
        SELECT 1 FROM "PieceLien" x
        WHERE x."pieceId" = pl."pieceId" AND x."sujetType" = 'PERSONNE' AND x."sujetId" = ${p.gardeeId} AND x."role" = pl."role"
      )`;

  for (const r of absorbee.roles) await assurerRole(db, p.gardeeId, r.role, p.parId);
  const ajout = complements(gardee, { nom: absorbee.nom, prenoms: absorbee.prenoms, civilite: absorbee.civilite, naissance: absorbee.naissance });
  const nationalite = !gardee.nationalite && absorbee.nationalite ? { nationalite: absorbee.nationalite } : {};
  if (Object.keys(ajout).length || Object.keys(nationalite).length) {
    await db.personne.update({
      where: { id: p.gardeeId },
      data: { ...ajout, ...nationalite, completude: completude({ ...gardee, ...ajout, ...nationalite }) },
    });
  }
  await db.personne.update({ where: { id: absorbeeId }, data: { fusionneeDansId: p.gardeeId } });
  await db.doublonPersonne.update({
    where: { id: d.id },
    data: { statut: "FUSIONNE", gardeeId: p.gardeeId, deplacees, decideParId: p.parId, decideLe: new Date() },
  });
  return { absorbeeId, deplacees };
}

export async function ecarterDoublon(db: Db, p: { doublonId: string; parId: string }): Promise<void> {
  const d = await chargerProposition(db, p.doublonId);
  if (d.statut !== "PROPOSE") throw new RefusFusionPersonne("Cette proposition a déjà été tranchée.");
  await db.doublonPersonne.update({ where: { id: d.id }, data: { statut: "ECARTE", decideParId: p.parId, decideLe: new Date() } });
}

export async function annulerFusionPersonnes(db: Db, p: { doublonId: string; parId: string }): Promise<{ revenues: number }> {
  const d = await chargerProposition(db, p.doublonId);
  if (d.statut !== "FUSIONNE" || !d.gardeeId) throw new RefusFusionPersonne("Cette proposition n'est pas une fusion.");
  const absorbeeId = d.gardeeId === d.personneAId ? d.personneBId : d.personneAId;
  const absorbee = await db.personne.findUnique({ where: { id: absorbeeId }, select: { fusionneeDansId: true } });
  if (absorbee?.fusionneeDansId !== d.gardeeId) throw new RefusFusionPersonne("La fusion a déjà été défaite ou remplacée.");

  let revenues = 0;
  for (const ref of d.deplacees) {
    const [source, id] = ref.split(":");
    if (!estSourcePersonne(source) || !id) continue;
    // Une ligne qui a changé de Personne depuis (autre fusion, correction) ne revient pas.
    revenues += (await delegue(db, source).updateMany({ where: { id, personneId: d.gardeeId }, data: { personneId: absorbeeId } })).count;
  }
  await db.personne.update({ where: { id: absorbeeId }, data: { fusionneeDansId: null } });
  await db.doublonPersonne.update({
    where: { id: d.id },
    data: { statut: "PROPOSE", gardeeId: null, deplacees: [], decideParId: p.parId, decideLe: new Date() },
  });
  return { revenues };
}
