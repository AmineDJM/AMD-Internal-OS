import { prisma } from "@/lib/prisma";
import { journaliser } from "@/lib/missions/runtime/store";
import { signalerUneFois } from "@/lib/missions/travaux/signaux";
import { cloreEcriture, reclamerEcriture } from "@/lib/missions/travaux/ecritures";
import { lireDossier, sessionParlable } from "@/lib/missions/chantiers/dossier";
import { horsPerimetre } from "@/lib/missions/chantiers/perimetre";
import { travailleurCloud } from "@/lib/missions/equipe/travailleurs";
import { ressourcesHorsReservation } from "@/lib/missions/equipe/ressources";
import type { AgentDeveloppeur } from "@/lib/missions/chantiers/ports-moteur";
import { cleReservation, demandesDuPlan, libererCles } from "@/lib/missions/chantiers/reservations";
import { avancerFile, deposerEnFile, type DepsFile, type ForgeIntegration } from "@/lib/missions/equipe/integration";
import { ecrireDossierProgramme, lireLeDossierProgramme } from "@/lib/missions/equipe/dossier";
import type { ContexteIntegration, Integrer } from "@/lib/missions/equipe/conduite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PROGRAMME ET SA FILE D'INTÉGRATION (lot O2, décision 0059 § 6) — à chaque passage du programme :
 *   1. ses tâches vertes (chantier COMPLETED, SHA vérifié) entrent en file — une entrée par (chantier, SHA) ;
 *   2. la file de SA cible avance (une intégration à la fois, quel que soit le programme qui l'a déposée) ;
 *   3. l'état de chaque tâche suit son entrée : intégrée (réservations RENDUES, dépendants débloqués), renvoyée à son
 *      travailleur (même session, travail préservé : sa branche n'est jamais touchée), ou en cours ;
 *   4. une tâche renvoyée qui pousse un nouveau commit VERT rentre en file ; au 3ᵉ renvoi la Direction est prévenue,
 *      au 6ᵉ la tâche échoue (le programme replanifie).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const RENVOIS_ALERTE = 3;
export const RENVOIS_MAX = 6;

interface DetailEntree { raison?: string; fichiers?: string[]; recette?: string[] | null; extrait?: string; renvoye?: boolean }

function texteDeRenvoi(cible: string, base: string | null, d: DetailEntree): string {
  const tete = `${cible}${base ? ` @ ${base.slice(0, 7)}` : ""}`;
  if (d.recette) return `La file d'intégration n'a pas pu intégrer ta branche dans ${tete} : seuls des fichiers GÉNÉRÉS divergent (${(d.fichiers ?? []).join(", ")}). Fusionne origin/${cible} dans ta branche (ton travail est gardé), puis régénère : ${d.recette.join(" && ")} ; relance les vérifications et pousse.`;
  if (d.extrait) return `Ta branche, intégrée avec la dernière version de ${tete}, fait ÉCHOUER la CI (une incompatibilité que Git ne signale pas : un nom changé, un contrat régénéré…). Fusionne origin/${cible} dans ta branche, corrige, vérifie, pousse. Extrait :\n${d.extrait.slice(0, 3_000)}`;
  return `Ta branche entre en CONFLIT avec ${tete}${d.fichiers?.length ? ` sur : ${d.fichiers.join(", ")}` : ""}. Fusionne origin/${cible} dans ta branche en gardant ton travail, résous, relance les vérifications et pousse.`;
}

/** Le renvoi à la MÊME session (sinon une reprise de la branche), sous reçu : un redémarrage ne l'envoie pas deux fois. */
async function renvoyer(programmeId: string, entreeId: string, chantierId: string, texte: string, agent: AgentDeveloppeur | null): Promise<string | null> {
  if (!agent) return null;
  const m = await prisma.mission.findUnique({ where: { id: chantierId }, select: { carnet: true } });
  const dc = lireDossier(m?.carnet);
  if (!dc) return null;
  const cle = `${entreeId}|renvoi`;
  const recu = await reclamerEcriture(cle, programmeId, "integration", "programme:renvoi");
  if (recu.etat !== "NEUF") return recu.etat === "FAIT" ? "deja" : null;
  const p = dc.plan;
  const session = sessionParlable(dc);
  const r = await travailleurCloud(agent).envoyer({
    depot: p.depot, branche: p.branche, brancheBase: p.brancheBase, objectif: p.objectif, perimetre: p.perimetre, criteres: p.criteres, commandesVerif: p.commandesVerif, chantierId,
  }, session ?? null, texte, cle);
  await cloreEcriture(cle, r.ok ? "FAIT" : "ECHEC", r.ok ? r.valeur : { erreur: r.erreur });
  return r.ok ? r.valeur.moyen : null;
}

/** L'intégrateur d'un programme, sur une forge et l'agent des travailleurs. */
export function integrateur(forge: ForgeIntegration, agent: AgentDeveloppeur | null, sonde?: DepsFile["sonde"]): Integrer {
  return async (ctx: ContexteIntegration) => {
    const { programmeId, principalId, clock } = ctx;
    const d = ctx.dossier;
    const p = d.plan;
    const chantiers = await prisma.mission.findMany({ where: { id: { in: Object.values(d.taches).map((t) => t.chantierId).filter((x): x is string => !!x) } }, select: { id: true, carnet: true } });
    const dossierDe = (id: string | null) => lireDossier(chantiers.find((c) => c.id === id)?.carnet);
    // 1. LES TÂCHES VERTES ENTRENT EN FILE.
    for (const [cle, t] of Object.entries(d.taches)) {
      const sha = dossierDe(t.chantierId)?.vert?.sha;
      if (t.etat === "EN_FILE" && t.chantierId && sha) await deposerEnFile({ programmeId, chantierId: t.chantierId, tacheCle: cle, depot: p.depot, cible: p.cible, branche: t.branche, shaTache: sha });
    }
    // 2. LA FILE DE LA CIBLE AVANCE (plusieurs pas : une entrée finie libère la place pour la suivante).
    const depot = `${p.depot.proprietaire}/${p.depot.nom}`.toLowerCase();
    for (let i = 0; i < 4; i++) {
      const r = await avancerFile(depot, p.cible, { forge, clock, ...(sonde ? { sonde } : {}) });
      if (!r || !["FUSIONNEE", "RENVOYEE", "EN_FILE"].includes(r.statut)) break;
    }
    // 3. L'ÉTAT DES TÂCHES SUIT LEUR DERNIÈRE ENTRÉE.
    const entrees = await prisma.integrationFile.findMany({ where: { programmeId }, orderBy: { createdAt: "desc" } });
    const derniere = (cle: string) => entrees.find((e) => e.tacheCle === cle);
    const le = clock.now().toISOString();
    for (const [cle, t] of Object.entries((await lireLeDossierProgramme(programmeId)).taches)) {
      const e = derniere(cle);
      if (!e || !["EN_FILE", "EN_INTEGRATION", "RETOUR"].includes(t.etat) || e.chantierId !== t.chantierId) continue;
      const det = (e.detail ?? {}) as DetailEntree;
      if (e.statut === "FUSIONNEE" && t.etat !== "INTEGREE") {
        const plan = dossierDe(t.chantierId)?.plan;
        const rendues = plan ? await libererCles(programmeId, demandesDuPlan(plan).map(cleReservation)) : 0;
        await ecrireDossierProgramme(programmeId, (x) => Object.assign(x.taches[cle]!, { etat: "INTEGREE", integreeSha: e.shaIntegration, raison: det.raison ?? null, majLe: le }));
        await journaliser(programmeId, "PROGRAMME_TACHE_INTEGREE", `Tâche « ${cle} » intégrée (${rendues} réservation(s) rendue(s)).`, { tache: cle }, principalId);
      } else if (e.statut === "RENVOYEE" && !det.renvoye) {
        const renvois = t.renvois + 1;
        const moyen = await renvoyer(programmeId, e.id, t.chantierId!, texteDeRenvoi(p.cible, e.shaBase, det), agent);
        await prisma.integrationFile.update({ where: { id: e.id }, data: { detail: { ...det, renvoye: true } } });
        const echec = renvois >= RENVOIS_MAX;
        await ecrireDossierProgramme(programmeId, (x) => Object.assign(x.taches[cle]!, { etat: echec ? "ECHEC" : "RETOUR", renvois, raison: `${det.raison ?? "renvoyée"}${moyen ? ` — renvoyée au travailleur (${moyen})` : ""}`.slice(0, 300), majLe: le }));
        await journaliser(programmeId, "PROGRAMME_TACHE_RENVOYEE", `Tâche « ${cle} » renvoyée à son travailleur (${renvois}ᵉ fois) : ${det.raison ?? "?"}.`, { tache: cle, fichiers: det.fichiers ?? [] }, principalId);
        if (renvois === RENVOIS_ALERTE) await signalerUneFois(programmeId, principalId, `renvois:${cle}`, `Intégration difficile — tâche « ${cle} »`, `${renvois} renvois : ${det.raison ?? ""}. Le travailleur continue ; vous pouvez donner une consigne.`);
      } else if (["EN_COURS", "CI", "A_VALIDER"].includes(e.statut) && t.etat !== "EN_INTEGRATION") {
        await ecrireDossierProgramme(programmeId, (x) => Object.assign(x.taches[cle]!, { etat: "EN_INTEGRATION", raison: e.statut === "A_VALIDER" ? `CI verte sur l'intégration ${e.shaIntegration?.slice(0, 7)} : attend votre validation pour ${p.cible}` : `en intégration (${e.statut})`, majLe: le }));
      }
      if (e.statut === "A_VALIDER") {
        await signalerUneFois(programmeId, principalId, `integration:${e.id}`, `Validation demandée — intégration dans ${p.cible}`, `Tâche « ${cle} » : CI verte sur le résultat intégré ${e.shaIntegration?.slice(0, 7)} (base ${e.shaBase?.slice(0, 7)}). Répondez « valide » ou « refuse ».`);
      }
    }
    // 4. UNE TÂCHE RENVOYÉE QUI POUSSE UN COMMIT VERT RENTRE EN FILE.
    for (const [cle, t] of Object.entries((await lireLeDossierProgramme(programmeId)).taches)) {
      if (t.etat !== "RETOUR" || !t.chantierId) continue;
      const tete = await forge.tete(p.depot, t.branche);
      const avant = derniere(cle)?.shaTache;
      if (!tete.ok || !tete.valeur || tete.valeur === avant) continue;
      const c = await forge.checks(p.depot, tete.valeur);
      if (!c.ok || c.valeur.statut !== "vert") continue;
      // Le nouveau commit RESTE dans son périmètre et ses ressources réservées (le chantier, fini, ne le revérifie plus).
      const plan = dossierDe(t.chantierId)?.plan;
      const fichiers = await forge.fichiersModifies(p.depot, p.cible, tete.valeur);
      const hors = plan && fichiers.ok ? [...horsPerimetre(fichiers.valeur, plan.perimetre), ...(plan.ressources ? ressourcesHorsReservation(fichiers.valeur, plan.ressources) : [])] : ["lecture des fichiers impossible"];
      if (hors.length) {
        if (!t.raison?.startsWith("hors périmètre")) await ecrireDossierProgramme(programmeId, (x) => { x.taches[cle]!.raison = `hors périmètre : ${hors.slice(0, 6).join(", ")} — pas remis en file`; });
        continue;
      }
      await deposerEnFile({ programmeId, chantierId: t.chantierId, tacheCle: cle, depot: p.depot, cible: p.cible, branche: t.branche, shaTache: tete.valeur });
      await ecrireDossierProgramme(programmeId, (x) => Object.assign(x.taches[cle]!, { etat: "EN_FILE", raison: `nouveau commit vert ${tete.valeur!.slice(0, 7)} : de nouveau en file`, majLe: le }));
    }
  };
}
