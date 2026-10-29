import type { PowerTool } from "@/platform/ia/outil";
// Par le PONT, pas par `lib/rbac` : un import direct est un franchissement de la frontière (§118.136).
import { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/platform/in-process/adapter";

/** Le type de la personne, tel que la boîte à outils le reçoit — sans importer la session (frontière). */
type Utilisateur = Parameters<PowerTool["run"]>[1];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « SURVEILLE CE DOSSIER ET PRÉVIENS-MOI SEULEMENT S'IL Y A UN PROBLÈME » — les trois gestes.
 *
 * Ce ne sont pas des rappels (un rappel sonne à une date) : une surveillance RELIT une cible à
 * sa cadence et dès qu'un fait la touche, applique des RÈGLES codées (échéance qui approche ou
 * passée, silence, blocage, statut, seuil, disparition) et ne parle que quand la signature du
 * problème change. Elle survit aux redémarrages (table + mission-support) ; l'écran des missions
 * la montre ; suspendre / arrêter passent par les gestes de conduite existants.
 *
 * Le pont (`platform/in-process/missions/watch.ts`) est chargé à la demande : ce module est tiré
 * par la boîte à outils entière, et le pont tire la porte d'attention et le registre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * RÉSERVÉ AU SUPER ADMIN (décision de la Direction, 09/2026). Une surveillance EST une mission
 * (kind WATCH, même moteur, même journal, même battement) : elle suit le prédicat UNIQUE des
 * missions d'Adam, `peutPiloterMissionsAdam` — hier, le PDG y avait droit aussi.
 */
const EXEC = (u: Utilisateur): boolean => peutPiloterMissionsAdam(u);
const REFUS_SURVEILLANCE = `${REFUS_MISSIONS_ADAM} Pour être prévenu à une date, propose un rappel (plan_reminder) — et dis-le à la personne.`;
const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";
const num = (input: Record<string, unknown>, key: string): number | null =>
  typeof input[key] === "number" && Number.isFinite(input[key] as number) ? (input[key] as number) : null;

export const WATCH_TOOLS: PowerTool[] = [
  {
    def: {
      name: "watch_entity",
      description: "SURVEILLANCE DURABLE : « surveille ce dossier / cette tâche / ce règlement / ce partenaire / ce contrat / cette facture / cette enveloppe budgétaire / "
        + "la réponse de X à mon e-mail / l'arrivée du document Y, et préviens-moi seulement s'il y a un problème ». "
        + "Crée une surveillance qui relit la cible à sa cadence ET dès qu'un fait la touche, applique des règles CODÉES (échéance proche ou dépassée, silence, blocage, statut, seuil, disparition) "
        + "et ne notifie que quand un problème apparaît, disparaît, ou quand la cible est terminée. Survit aux redémarrages ; visible dans les missions (suspendre / arrêter). "
        + "Ce n'est PAS un rappel daté (plan_reminder) : ici rien ne sonne tant que tout va bien. "
        + "UNE SURVEILLANCE PRÉVIENT, ELLE N'AGIT PAS : « dès que / quand [un fait] arrive, FAIS [une action] » (créer une tâche, envoyer, classer, "
        + "relancer, archiver) est une MISSION — run_mission — qui ATTEND le fait (WAIT_EVENT) puis agit. Ne pose pas une surveillance à la place.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "UNE cible, jamais un critère. Une surveillance relit CETTE fiche et ne parle que d'elle : « les dossiers dont l'échéance tombe dans 60 jours » n'est pas une cible — lister d'abord les fiches, puis une surveillance PAR fiche (en mission : un déploiement en éventail sur la liste). Référence exacte (REG-2026-014, ORD-…, PAY-…, VAL-…, n° de facture ou de BC), ou nom (molécule, titre de tâche, partenaire, personne, titre ou contrepartie d'un contrat, nom d'enveloppe budgétaire, objet ou correspondant d'un fil e-mail de VOTRE boîte). Pour un document attendu : le motif du nom (voir expected_document). En cas d'ambiguïté l'outil liste les candidats." },
          label: { type: "string", description: "Le libellé de la surveillance tel que la personne l'a dit (facultatif)." },
          alert_on: {
            type: "array", items: { type: "string", enum: ["SANS_CHANGEMENT", "ECHEANCE_PROCHE", "ECHEANCE_DEPASSEE", "STATUT_PARMI", "STATUT_CHANGE", "BLOQUE", "DISPARU", "VALEUR"] },
            description: "Les règles à appliquer. Absent : les règles par défaut du type de cible (blocage, changement de statut, échéance, silence, disparition).",
          },
          silence_days: { type: "number", description: "SANS_CHANGEMENT : nombre de jours sans changement qui vaut alerte (défaut selon le type : 7 à 30)." },
          deadline_days: { type: "number", description: "ECHEANCE_PROCHE : alerter quand l'échéance est à moins de N jours (défaut 3 à 7)." },
          statuses: { type: "array", items: { type: "string" }, description: "STATUT_PARMI : les statuts qui déclenchent (ex. BLOCKED, RESPONDING_TO_QUERIES)." },
          check_every_hours: { type: "number", description: "Cadence de contrôle en heures (défaut 24 ; le registre des faits réveille de toute façon la surveillance dès qu'un fait touche la cible)." },
          instruction: { type: "string", description: "La phrase de la personne, mot pour mot — devient l'objectif de la mission-support." },
          expected_document: {
            type: "object",
            properties: { folder: { type: "string", description: "Le dossier Drive où on l'attend (nom). Absent : tout le Drive lisible." }, name_contains: { type: "string", description: "Ce que le nom du fichier doit contenir (ex. « CPP Nivolex »)." } },
            required: ["name_contains"],
            description: "DOCUMENT ATTENDU : surveille l'ARRIVÉE d'un fichier au Drive. Rien tant qu'il n'est pas là (sauf silence_days d'absence, défaut 7) ; quand il arrive, une information et la surveillance se clôt.",
          },
        },
        required: ["reference"],
      },
    },
    allowed: EXEC,
    refus: REFUS_SURVEILLANCE,
    label: "Surveillance créée",
    run: async (input, user) => {
      const reference = str(input, "reference");
      if (!reference) return "Donnez la cible à surveiller (référence ou nom).";
      const codes = Array.isArray(input.alert_on) ? (input.alert_on as unknown[]).filter((c): c is string => typeof c === "string") : [];
      const silence = num(input, "silence_days");
      const echeance = num(input, "deadline_days");
      const statuts = Array.isArray(input.statuses) ? (input.statuses as unknown[]).filter((s): s is string => typeof s === "string") : [];
      // Les règles DITES ; sans rien de dit, le pont applique celles du type.
      const regles = codes.length > 0
        ? codes.map((code) => ({
            code,
            ...(code === "SANS_CHANGEMENT" && silence ? { jours: silence } : {}),
            ...(code === "ECHEANCE_PROCHE" && echeance ? { jours: echeance } : {}),
            ...(code === "STATUT_PARMI" ? { valeurs: statuts } : {}),
          }))
        : [
            ...(silence ? [{ code: "SANS_CHANGEMENT", jours: silence }] : []),
            ...(echeance ? [{ code: "ECHEANCE_PROCHE", jours: echeance }] : []),
            ...(statuts.length ? [{ code: "STATUT_PARMI", valeurs: statuts }] : []),
          ];
      const { creerSurveillance } = await import("@/platform/in-process/missions/watch");
      const ed = input.expected_document && typeof input.expected_document === "object" ? (input.expected_document as Record<string, unknown>) : null;
      const attendu = ed && typeof ed.name_contains === "string" && ed.name_contains.trim() ? { motif: ed.name_contains.trim(), dossier: typeof ed.folder === "string" ? ed.folder.trim() || null : null } : null;
      const r = await creerSurveillance(user, {
        reference, label: str(input, "label") || null, regles: regles.length ? regles : null,
        checkEveryH: num(input, "check_every_hours"), instruction: str(input, "instruction") || null, attendu,
      });
      if (!r.ok) return JSON.stringify({ ok: false, message: r.raison, candidats: r.candidats.slice(0, 6).map((c) => ({ type: c.type, label: c.label, reference: c.ref ?? null })) });
      return JSON.stringify({
        ok: true, surveillance: r.id, mission: r.missionId, cible: r.cible.label, type: r.cible.type,
        regles: r.reglesTexte, etatActuel: r.etat.resume ?? null,
        prochainControle: r.prochainControle.toISOString(),
        message: `Je surveille ${r.cible.label}. Je ne vous préviendrai que si : ${r.reglesTexte}. Contrôle toutes les ${r.cadenceHeures} h et dès qu'un fait touche la cible ; arrêt : stop_watch.`,
      });
    },
  },
  {
    def: {
      name: "list_watches",
      description: "Liste les SURVEILLANCES actives de l'utilisateur : cible, règles, cadence, dernier état observé, problème en cours, identifiant (pour stop_watch).",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    refus: REFUS_SURVEILLANCE,
    label: "Surveillances listées",
    run: async (_input, user) => {
      const { listerSurveillances } = await import("@/platform/in-process/missions/watch");
      const rows = await listerSurveillances(user);
      if (rows.length === 0) return "Aucune surveillance active.";
      return JSON.stringify(rows);
    },
  },
  {
    def: {
      name: "stop_watch",
      description: "Arrête une surveillance (« arrête de surveiller le dossier X »). Donner l'identifiant rendu par list_watches / watch_entity, ou l'identifiant de sa mission.",
      input_schema: { type: "object", properties: { id: { type: "string", description: "Identifiant de la surveillance ou de sa mission-support." } }, required: ["id"] },
    },
    allowed: EXEC,
    refus: REFUS_SURVEILLANCE,
    label: "Surveillance arrêtée",
    run: async (input, user) => {
      const id = str(input, "id");
      if (!id) return "Donnez l'identifiant de la surveillance (list_watches).";
      const { arreterSurveillance } = await import("@/platform/in-process/missions/watch");
      const r = await arreterSurveillance(user, id);
      return r.ok ? JSON.stringify({ ok: true, arretee: true, message: `Je ne surveille plus ${r.label}.` }) : "Surveillance introuvable ou déjà arrêtée (list_watches pour vérifier).";
    },
  },
];
