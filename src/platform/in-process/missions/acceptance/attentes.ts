/**
 * Acceptance du Run 4 — LES ATTENTES : §5 WAIT_FOR_TIME (l'horloge avance, le chemin jamais) et
 * §2 WAIT_FOR_EVENT (le vrai bus, les non-réveils, la composition ET persistée).
 */
import { prisma } from "@/lib/prisma";
import { recordEvent } from "@/lib/events/ledger";
import { reveillerAttentesTemporelles } from "@/lib/missions/events/router";
import { type ContexteAcceptance, attendre, conduire, controle, etatEtape, lecture, planDe } from "./banc";

export async function scenariosAttentes(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, acteur, jouerScenario, lancer } = ctx;
  /* ═══════════════ §5 — WAIT_FOR_TIME : l'horloge avance, le chemin jamais ═══════════════ */

  await jouerScenario("TIME-1", "WAIT_FOR_TIME", "analyse → WAITING persisté → horloge avancée → réveil → conclusion", false, async () => {
    const criteres = ["le point est repris au moment demandé"];
    const dansDeuxHeures = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const plan = planDe("Reprendre plus tard", "S", criteres, [
      lecture("lire"),
      {
        key: "attente", title: "Revenir dans deux heures", nodeType: "WAIT_EVENT", capability: null,
        dependsOn: ["lire"], completionCondition: "le moment est arrivé",
        // « TEMPS » est la sentinelle du schéma STRICT : seule l'échéance compte, aucun fait.
        waitEvent: "TEMPS", waitUntil: dansDeuxHeures,
      },
      controle(["attente"]),
    ]);
    const { missionId, cerveau } = await lancer("Analyse l'annuaire maintenant et reviens dans deux heures conclure.", plan, criteres, { titre: "temps" });
    await conduire(acteur, missionId, cerveau);
    const etape = await prisma.missionStep.findFirst({
      where: { missionId, key: "attente" }, select: { status: true, waitFor: true },
    });
    attendre(etape?.status === "WAITING", `l'attente temporelle n'est pas parquée WAITING (${etape?.status})`);
    const persiste = (etape?.waitFor ?? {}) as Record<string, unknown>;
    attendre(persiste.until === dansDeuxHeures, "l'échéance n'est pas PERSISTÉE dans waitFor.until — elle ne survivrait pas à un redémarrage");

    // AVANT l'échéance : le balayage (horloge injectée) ne réveille RIEN.
    const avant = await reveillerAttentesTemporelles(new Date());
    attendre(!avant.some((r) => r.missionId === missionId), "réveillée AVANT son échéance — l'horloge n'est pas respectée");
    // APRÈS : le même balayage de production la règle. Aucun setTimeout nulle part.
    const apres = await reveillerAttentesTemporelles(new Date(Date.now() + 3 * 3_600_000));
    attendre(apres.some((r) => r.missionId === missionId), "l'échéance passée n'a pas réveillé la mission");
    const statut = await conduire(acteur, missionId, cerveau);
    attendre(statut === "COMPLETED", `après réveil temporel, la mission finit en ${statut}`);
    attendre(await prisma.missionEvent.findFirst({ where: { missionId, kind: "TIME_WAKE" }, select: { id: true } }),
      "aucun TIME_WAKE au journal");
    return {
      mesures: { echeance: dansDeuxHeures, horlogeAvanceeDe: "3 h" },
      preuve: "échéance persistée en base, ignorée avant l'heure, réglée par le balayage de production à horloge injectée, mission conclue — zéro setTimeout.",
    };
  });

  /* ═══════════════ §2 — WAIT_FOR_EVENT : le vrai bus, et les non-réveils ═══════════════ */

  await jouerScenario("EVT-1", "WAIT_FOR_EVENT", "quatre événements PRESQUE bons ne réveillent pas ; le bon réveille ; le rejeu est inerte", false, async () => {
    const expeditrice = `expeditrice-${TAG}@exemple.dz`;
    const criteres = ["le document attendu est arrivé et analysé"];
    const plan = planDe("Attendre le contrat", "S", criteres, [
      lecture("lire"),
      {
        key: "attente", title: "Attendre le contrat", nodeType: "WAIT_EVENT", capability: null,
        dependsOn: ["lire"], completionCondition: "le contrat est arrivé",
        waitEvent: "EMAIL_RECEIVED", waitFrom: expeditrice, waitSubject: "contrat", waitAttachment: "contrat*",
        waitWithinDays: 7,
      },
      controle(["attente"]),
    ]);
    const { missionId, cerveau } = await lancer("Attends le contrat de la correspondante, puis conclus.", plan, criteres, { titre: "événement" });
    await conduire(acteur, missionId, cerveau);
    attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "l'attente n'est pas WAITING");

    const enAttente = async (motif: string) => {
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING",
        `RÉVEIL À TORT : ${motif} a réglé l'attente — la panne la plus coûteuse du routeur`);
    };
    const evt = (payload: Record<string, unknown>) => recordEvent({
      type: "EMAIL_RECEIVED", sourceDomain: "comms", payload: { marqueur: TAG, ...payload },
    });
    await evt({ from: `intrus-${TAG}@exemple.dz`, subject: `contrat ${TAG}`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] });
    await enAttente("le mauvais expéditeur (même avec pièce)");
    await evt({ from: expeditrice, subject: `contrat ${TAG} — je l'envoie demain`, hasAttachments: false, attachments: [] });
    await enAttente("une promesse SANS pièce jointe");
    await evt({ from: expeditrice, subject: `facture ${TAG}`, hasAttachments: true, attachments: [`facture-${TAG}.pdf`] });
    await enAttente("le mauvais objet");
    await evt({ from: expeditrice, subject: `contrat ${TAG}`, hasAttachments: true, attachments: [`annexe-${TAG}.docx`] });
    await enAttente("une pièce au mauvais nom (motif contrat*)");

    // LE BON — et lui seul.
    await evt({ from: expeditrice, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-signe-${TAG}.pdf`] });
    attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "LE bon événement n'a pas réglé l'attente");
    // §42 : le REJEU du même fait (webhook dupliqué) ne casse rien.
    await evt({ from: expeditrice, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-signe-${TAG}.pdf`] });
    attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "le rejeu a déstabilisé une attente déjà réglée");
    const statut = await conduire(acteur, missionId, cerveau);
    attendre(statut === "COMPLETED", `après réveil, la mission finit en ${statut}`);
    return {
      mesures: { negatifsTestes: 4, rejeux: 1 },
      preuve: "4 événements presque-bons ignorés (expéditeur, pièce absente, objet, nom de pièce), le bon réveille via le bus réel, le rejeu est inerte, la mission conclut.",
    };
  });

  await jouerScenario("EVT-2", "WAIT_FOR_EVENT", "composition ET : progression PERSISTÉE branche par branche, rejeu idempotent", false, async () => {
    const expediteur = `fournisseur-${TAG}@exemple.dz`;
    const criteres = ["le contrat ET le devis sont arrivés"];
    const plan = planDe("Attendre contrat et devis", "S", criteres, [
      lecture("lire"),
      {
        key: "attente", title: "Attendre le contrat ET le devis", nodeType: "WAIT_EVENT", capability: null,
        dependsOn: ["lire"], completionCondition: "les deux pièces sont arrivées",
        // Le schéma STRICT exige chaque champ d'une branche, `null` compris — la forme
        // exacte qu'un fournisseur en mode strict produirait.
        waitEvent: "EMAIL_RECEIVED",
        waitAllOf: [
          { event: "EMAIL_RECEIVED", from: expediteur, entity: null, until: null, threadId: null, subject: null, attachment: "contrat*" },
          { event: "EMAIL_RECEIVED", from: expediteur, entity: null, until: null, threadId: null, subject: null, attachment: "devis*" },
        ],
      },
      controle(["attente"]),
    ]);
    const { missionId, cerveau } = await lancer("Attends le contrat et le devis du fournisseur avant de conclure.", plan, criteres, { titre: "composition" });
    await conduire(acteur, missionId, cerveau);
    attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "l'attente composée n'est pas WAITING");

    const contrat = () => recordEvent({
      type: "EMAIL_RECEIVED", sourceDomain: "comms",
      payload: { marqueur: TAG, from: expediteur, subject: `pièces ${TAG}`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] },
    });
    await contrat();
    const partielle = await prisma.missionStep.findFirst({ where: { missionId, key: "attente" }, select: { status: true, result: true } });
    attendre(partielle?.status === "WAITING", "UNE branche réglée a conclu une attente ET — la composition est cassée");
    const progres = ((partielle?.result ?? {}) as Record<string, unknown>).attenteProgres;
    attendre(Array.isArray(progres) && progres.length === 1,
      "la progression de la branche réglée n'est pas PERSISTÉE — un redémarrage redemanderait le contrat");
    await contrat(); // rejeu de la MÊME branche
    const rejouee = await prisma.missionStep.findFirst({ where: { missionId, key: "attente" }, select: { result: true } });
    attendre((((rejouee?.result ?? {}) as Record<string, unknown>).attenteProgres as unknown[]).length === 1,
      "le rejeu a compté la même branche deux fois");
    await recordEvent({
      type: "EMAIL_RECEIVED", sourceDomain: "comms",
      payload: { marqueur: TAG, from: expediteur, subject: `pièces ${TAG}`, hasAttachments: true, attachments: [`devis-${TAG}.pdf`] },
    });
    attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "les deux branches réglées n'ont pas conclu l'attente ET");
    const statut = await conduire(acteur, missionId, cerveau);
    attendre(statut === "COMPLETED", `la mission finit en ${statut}`);
    return {
      mesures: { branches: 2, progressionPersistee: true },
      preuve: "contrat seul → WAITING avec attenteProgres [0] EN BASE ; rejeu inerte ; devis → DONE ; mission conclue.",
    };
  });
}
