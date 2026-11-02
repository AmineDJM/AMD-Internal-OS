/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BOÎTE DE DÉCISION — le COMPOSEUR (§21). Aucune nouvelle source de données.
 *
 * Il relit les files que les modules tiennent déjà — validations à MON tour, centre de
 * paiement, accords de mission, missions qui attendent une réponse, notifications non lues,
 * décisions à revoir, engagements en retard, le reste du centre d'action — et en fait des
 * cartes dont chaque option est le geste canonique du module. Il ne connaît aucun modèle : ce
 * qu'il rend est arithmétique, filtré par les droits de la personne (chaque file l'est déjà),
 * et il se mesure : chaque source dit combien de millisecondes elle a coûté.
 *
 * Les huit lectures partent ENSEMBLE. La cible du mandat est un chargement utile P95 < 1,5 s ;
 * `inbox.test.ts` la mesure sur une base réelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { requireModule } from "@/lib/session";
import { userCan, type SessionUser } from "@/lib/rbac";
import { getActionCenter, PREFIXE_CONGE, PREFIXE_DEMANDE_ADMIN } from "@/lib/queries/action-center";
import { getPendingValidations } from "@/lib/queries/validations";
import { approbationsEnAttente } from "@/lib/missions/approval/gate";
import { sitsOnPaymentCentre, ORDRE_NON_ANNULE } from "@/modules/finances/partage";
import { lireConstats } from "@/lib/quality/read";
import { intelligenceComplete, LIBELLE_GRAVITE as LIBELLE_GRAVITE_SIGNAL, type Signal } from "@/platform/in-process/intelligence";
import { lireEtatChaud } from "@/lib/fabric/hot-state";
import { LIBELLE_CRITICITE, LIBELLE_FAMILLE, type FamilleQualite } from "@/lib/quality/model";
import { formatCurrency, toNumber } from "@/lib/utils";
import {
  compterParGenre, delaiHumain, joursAvant, ordonner, recommanderAccord, recommanderEngagement, tronquer, urgenceDe,
  type OptionCarte, type CarteInbox, type GenreCarte,
} from "@/lib/assistant/inbox/model";

export interface VueInbox {
  cartes: CarteInbox[];
  compte: Record<GenreCarte, number>;
  /** Durée totale de composition, en millisecondes. */
  ms: number;
  /** Ce que chaque file a coûté et rendu — pour savoir laquelle ralentit, sans deviner. */
  sources: { nom: string; ms: number; n: number }[];
}

/** Une file mesurée : une file qui casse ne fait pas tomber la boîte, elle rend zéro et se dit. */
const ETAT_INTELLIGENCE = "intelligence-metier-inbox";
const TTL_INTELLIGENCE_MS = 10 * 60 * 1000;

async function file<T>(nom: string, fn: () => Promise<T[]>): Promise<{ nom: string; ms: number; lignes: T[] }> {
  const t0 = Date.now();
  try {
    const lignes = await fn();
    return { nom, ms: Date.now() - t0, lignes };
  } catch (e) {
    console.error(`[inbox] file « ${nom} » en erreur`, e);
    return { nom, ms: Date.now() - t0, lignes: [] };
  }
}

const dateFr = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(x.getTime()) ? null : new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "Africa/Algiers" }).format(x);
};

const adam = (phrase: string) => `/chief-of-staff?q=${encodeURIComponent(phrase)}`;

/** Ce qu'une étape WAIT_INPUT demande, si elle l'a écrit dans son entrée ; sinon son titre. */
function questionDe(input: unknown, titre: string): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["question", "demande", "message", "texte", "prompt"]) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) return tronquer(o[k] as string, 240);
    }
  }
  return titre;
}

export async function composerInbox(user: SessionUser): Promise<VueInbox> {
  const t0 = Date.now();
  const now = new Date();

  const [[validations, paiements, accords, attentes, notifications, decisions, engagements, centre], qualite, intelligence] = await Promise.all([Promise.all([
    file("validations", async () => (userCan(user, "VALIDATIONS", "VIEW") ? (await getPendingValidations(user.id)).filter((v) => v.actionable) : [])),
    file("paiements", async () => (sitsOnPaymentCentre(user)
      ? prisma.expenseOrder.findMany({
        where: { centralStatus: "AWAITING", ...ORDRE_NON_ANNULE },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], take: 40,
        select: { id: true, reference: true, label: true, beneficiary: true, amount: true, dueDate: true, createdAt: true },
      })
      : [])),
    file("accords", () => approbationsEnAttente(user.id)),
    file("attentes", () => prisma.mission.findMany({
      where: { ownerId: user.id, status: "WAITING_INPUT" },
      orderBy: { updatedAt: "asc" }, take: 20,
      select: { id: true, title: true, updatedAt: true, steps: { where: { status: "WAITING" }, select: { key: true, title: true, input: true }, take: 3 } },
    })),
    file("notifications", () => prisma.notification.findMany({
      where: { userId: user.id, isRead: false },
      orderBy: [{ popup: "desc" }, { createdAt: "desc" }], take: 8,
      select: { id: true, title: true, body: true, link: true, type: true, popup: true, createdAt: true },
    })),
    file("decisions", () => prisma.executiveDecision.findMany({
      where: { ownerId: user.id, status: { in: ["PROPOSED", "DECIDED"] }, reviewDate: { lte: now } },
      orderBy: { reviewDate: "asc" }, take: 10,
      select: { id: true, title: true, decision: true, expectedOutcome: true, reviewDate: true, createdAt: true },
    })),
    file("engagements", () => prisma.executiveCommitment.findMany({
      where: { ownerId: user.id, status: "OPEN", dueAt: { lt: now } },
      orderBy: { dueAt: "asc" }, take: 15,
      select: { id: true, who: true, toWhom: true, what: true, dueAt: true, promisedAt: true, source: true, relatedRef: true, createdAt: true },
    })),
    // Les congés et les approbations d'achat n'ont pas d'autre file ici : avant le lot E2 le centre les rendait
    // sous les genres « hr » et « request », que ce filtre laissait passer — la boîte les garde (§118.61).
    file("centre", async () => (await getActionCenter(user)).items.filter((i) =>
      (i.kind !== "validation" && i.kind !== "payment") || i.objet.startsWith(PREFIXE_CONGE) || i.objet.startsWith(PREFIXE_DEMANDE_ADMIN))),
    ]),
    // LA QUALITÉ DES DONNÉES (§23) : les constats critiques et hauts qui attendent une personne —
    // sous ses droits, cinq au plus, pour ne pas noyer les décisions du jour.
    file("qualite", () => lireConstats(user, { statut: "OPEN", limite: 40 }).then((l) => l.filter((c) => c.criticite === "CRITIQUE" || c.criticite === "HAUTE").slice(0, 5))),
    // L'INTELLIGENCE MÉTIER (§27) : les signaux CRITIQUES et HAUTS de Regulatory, Legal et Finance —
    // calculés sous les droits de la personne, mis en réserve dix minutes (état chaud, jamais
    // recalculés à chaque ouverture), cinq au plus.
    file("intelligence", () => lireEtatChaud<Signal[]>(ETAT_INTELLIGENCE, user.id, {
      ttlMs: TTL_INTELLIGENCE_MS,
      calcul: async () => (await intelligenceComplete(user, { leger: true })).signaux.filter((s) => s.gravite === "CRITIQUE" || s.gravite === "HAUTE").slice(0, 12),
    }).then((l) => l.valeur.slice(0, 5))),
  ]);

  const cartes: CarteInbox[] = [];

  // ── VALIDATIONS À MON TOUR ──────────────────────────────────────────────────────────────
  for (const v of validations.lignes) {
    const delai = delaiHumain(v.deadline, now);
    const contexte = [
      v.requester ? `Demandé par ${v.requester}` : null,
      v.module,
      v.amount !== null ? formatCurrency(v.amount) : null,
      v.documents.length ? `${v.documents.length} pièce${v.documents.length > 1 ? "s" : ""} jointe${v.documents.length > 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" · ") + (v.description ? ` — ${tronquer(v.description, 160)}` : "");
    cartes.push({
      id: `val:${v.stepId}`, genre: "APPROVE", sujet: v.title, contexte,
      raison: `Votre validation est attendue${delai ? ` (${delai})` : ""} : ${v.requester || "le demandeur"} ne peut pas avancer sans elle.`,
      echeance: v.deadline,
      urgence: urgenceDe({ genre: "APPROVE", echeance: v.deadline, priorite: v.priority, montant: v.amount, bloqueQuelquun: true }, now),
      impact: v.amount !== null ? formatCurrency(v.amount) : null,
      recommandation: null,
      options: [
        { id: "approuver", libelle: "Approuver", ton: "primaire", effet: `Approuve l'étape ${v.reference} en votre nom ; le circuit continue.`, geste: { kind: "validation.decide", stepId: v.stepId, decision: "APPROVED" } },
        { id: "modifier", libelle: "Demander une modification", ton: "neutre", effet: "Renvoie la demande au demandeur avec ce qu'il faut changer.", geste: { kind: "validation.decide", stepId: v.stepId, decision: "CHANGES_REQUESTED" }, saisie: { libelle: "Ce qu'il faut modifier", obligatoire: true } },
        { id: "refuser", libelle: "Refuser", ton: "danger", effet: "Refuse la demande ; votre motif est transmis au demandeur.", geste: { kind: "validation.decide", stepId: v.stepId, decision: "REJECTED" }, saisie: { libelle: "Motif du refus", obligatoire: true } },
      ],
      source: { module: "Validations", libelle: v.reference, href: `/validations?focus=${v.stepId}#val-${v.stepId}` },
      depuis: v.createdAt,
    });
  }

  // ── CENTRE DE PAIEMENT ──────────────────────────────────────────────────────────────────
  for (const o of paiements.lignes) {
    const montant = toNumber(o.amount);
    const echeance = o.dueDate?.toISOString() ?? null;
    cartes.push({
      id: `pay:${o.id}`, genre: "APPROVE", sujet: o.label,
      contexte: [o.reference, o.beneficiary ? `Bénéficiaire : ${o.beneficiary}` : null, formatCurrency(montant)].filter(Boolean).join(" · "),
      raison: `L'ordre attend l'autorisation du centre de paiement${echeance ? ` (${delaiHumain(echeance, now)})` : ""}.`,
      echeance,
      urgence: urgenceDe({ genre: "APPROVE", echeance, montant, bloqueQuelquun: true }, now),
      impact: formatCurrency(montant),
      recommandation: null,
      options: [
        { id: "approuver", libelle: "Autoriser", ton: "primaire", effet: "Autorise le décaissement ; le comptable peut régler.", geste: { kind: "paiement.decide", orderId: o.id, decision: "APPROVE" } },
        // « Demander un complément » (REQUEST_INFO) a quitté le centre avec la décision du 02/09/2026 :
        // l'action le refuse (« Décision invalide »), et le proposer ici était un bouton qui échoue
        // après le clic (audit 360°, R03 ; §118.83).
        { id: "refuser", libelle: "Refuser", ton: "danger", effet: "Refuse le décaissement ; le motif est transmis.", geste: { kind: "paiement.decide", orderId: o.id, decision: "REFUSE" }, saisie: { libelle: "Motif du refus", obligatoire: true } },
      ],
      source: { module: "Centre de paiement", libelle: o.reference, href: `/finances/centre-de-paiement?focus=${o.id}` },
      depuis: o.createdAt.toISOString(),
    });
  }

  // ── ACCORDS DE MISSION ──────────────────────────────────────────────────────────────────
  for (const a of accords.lignes) {
    const etapes = a.stepKeys.length;
    cartes.push({
      id: `accord:${a.id}`, genre: "APPROVE", sujet: a.mission.title,
      contexte: tronquer(a.summary, 240),
      raison: `La mission attend votre accord pour ${etapes} étape${etapes > 1 ? "s" : ""} — niveau ${a.level === "CRITICAL" ? "critique" : a.level === "SENSITIVE" ? "sensible" : "normal"}.`,
      echeance: null,
      urgence: urgenceDe({ genre: "APPROVE", niveau: a.level, bloqueQuelquun: true }, now),
      impact: `${etapes} étape${etapes > 1 ? "s" : ""}`,
      recommandation: recommanderAccord(a.level, etapes),
      options: [
        { id: "accorder", libelle: "Donner l'accord", ton: "primaire", effet: "La mission repart immédiatement sur le périmètre résumé.", geste: { kind: "mission.accord", approvalId: a.id, decision: "GRANTED" } },
        { id: "refuser", libelle: "Refuser", ton: "danger", effet: "Les étapes concernées ne seront pas exécutées.", geste: { kind: "mission.accord", approvalId: a.id, decision: "REFUSED" } },
        { id: "voir", libelle: "Voir la mission", ton: "neutre", effet: "Ouvre la mission dans le bureau d'Adam.", geste: { kind: "adam", phrase: `Où en est la mission « ${a.mission.title} » ? Montre-moi le plan et ce qui attend mon accord.` } },
      ],
      source: { module: "Missions", libelle: a.mission.title, href: adam(`Où en est la mission « ${a.mission.title} » ?`) },
      depuis: a.createdAt.toISOString(),
    });
  }

  // ── MISSIONS QUI ATTENDENT UNE RÉPONSE ──────────────────────────────────────────────────
  for (const m of attentes.lignes) {
    const etape = m.steps[0] ?? null;
    const question = etape ? questionDe(etape.input, etape.title) : "La mission attend un élément de votre part.";
    cartes.push({
      id: `attente:${m.id}`, genre: "CHOOSE", sujet: m.title, contexte: question,
      raison: "La mission est arrêtée tant que vous n'avez pas répondu.",
      echeance: null,
      urgence: urgenceDe({ genre: "CHOOSE", bloqueQuelquun: true }, now),
      impact: null, recommandation: null,
      options: [
        ...(etape ? [{ id: "repondre", libelle: "Répondre", ton: "primaire" as const, effet: "Votre réponse est fournie à l'étape ; la mission repart.", geste: { kind: "mission.element" as const, missionId: m.id, stepKey: etape.key }, saisie: { libelle: "Votre réponse", obligatoire: true } }] : []),
        { id: "voir", libelle: "Voir la mission", ton: "neutre", effet: "Ouvre la mission dans le bureau d'Adam.", geste: { kind: "adam", phrase: `Où en est la mission « ${m.title} » et qu'attend-elle de moi ?` } },
      ],
      source: { module: "Missions", libelle: m.title, href: adam(`Où en est la mission « ${m.title} » ?`) },
      depuis: m.updatedAt.toISOString(),
    });
  }

  // ── NOTIFICATIONS NON LUES ──────────────────────────────────────────────────────────────
  for (const n of notifications.lignes) {
    const href = n.link && n.link.startsWith("/") ? n.link : "/notifications";
    cartes.push({
      id: `notif:${n.id}`, genre: "FYI", sujet: n.title, contexte: tronquer(n.body, 200),
      raison: `Signalée le ${dateFr(n.createdAt) ?? "—"} · non lue${n.popup ? " · marquée importante" : ""}.`,
      echeance: null,
      urgence: n.popup ? "HAUTE" : "BASSE",
      impact: null, recommandation: null,
      options: [
        { id: "vu", libelle: "Vu", ton: "neutre", effet: "Marque la notification comme lue.", geste: { kind: "notification.lue", notificationId: n.id } },
        ...(n.link && n.link.startsWith("/") ? [{ id: "ouvrir", libelle: "Ouvrir", ton: "primaire" as const, effet: "Ouvre l'objet concerné.", geste: { kind: "ouvrir" as const, href } }] : []),
      ],
      source: { module: "Notifications", libelle: n.type.toLowerCase().replace(/_/g, " "), href },
      depuis: n.createdAt.toISOString(),
    });
  }

  // ── DÉCISIONS À REVOIR ──────────────────────────────────────────────────────────────────
  for (const d of decisions.lignes) {
    cartes.push({
      id: `dec:${d.id}`, genre: "REVIEW", sujet: d.title,
      contexte: [d.decision ? `Décidé : ${tronquer(d.decision, 120)}` : null, d.expectedOutcome ? `Attendu : ${tronquer(d.expectedOutcome, 120)}` : null].filter(Boolean).join(" · "),
      raison: `Date de revue atteinte (${dateFr(d.reviewDate) ?? "—"}) : le résultat réel reste à constater.`,
      echeance: d.reviewDate?.toISOString() ?? null,
      urgence: "NORMALE",
      impact: null, recommandation: null,
      options: [
        { id: "revoir", libelle: "Revoir avec Adam", ton: "primaire", effet: "Adam rassemble ce qui s'est passé depuis la décision.", geste: { kind: "adam", phrase: `Revoyons la décision « ${d.title} » : qu'est-ce qui s'est passé depuis, et le résultat attendu est-il là ?` } },
      ],
      source: { module: "Décisions", libelle: d.title, href: adam(`Revoyons la décision « ${d.title} »`) },
      depuis: d.createdAt.toISOString(),
    });
  }

  // ── ENGAGEMENTS EN RETARD ───────────────────────────────────────────────────────────────
  for (const e of engagements.lignes) {
    const echeance = e.dueAt?.toISOString() ?? null;
    const retard = -(joursAvant(echeance, now) ?? 0);
    const phrase = `Relance ${e.who} pour « ${e.what} »${e.toWhom ? ` (promis à ${e.toWhom})` : ""}.`;
    cartes.push({
      id: `eng:${e.id}`, genre: "REVIEW", sujet: `${e.who} : ${e.what}`,
      contexte: [e.toWhom ? `Promis à ${e.toWhom}` : null, e.promisedAt ? `le ${dateFr(e.promisedAt)}` : null, e.source ? `source : ${e.source}` : null, e.relatedRef ? `réf. ${e.relatedRef}` : null].filter(Boolean).join(" · "),
      raison: `Échéance dépassée (${delaiHumain(echeance, now) ?? "—"}) et engagement toujours ouvert.`,
      echeance,
      urgence: urgenceDe({ genre: "REVIEW", echeance }, now),
      impact: null,
      recommandation: recommanderEngagement(retard),
      options: [
        { id: "relancer", libelle: "Relancer", ton: "primaire", effet: "Adam prépare la relance nominative — à confirmer avant envoi.", geste: { kind: "adam", phrase } },
        { id: "suivre", libelle: "Où en est-on ?", ton: "neutre", effet: "Adam rassemble ce qui a bougé sur cet engagement.", geste: { kind: "adam", phrase: `Où en est l'engagement de ${e.who} : « ${e.what} » ?` } },
      ],
      source: { module: "Engagements", libelle: e.who, href: adam(`Où en est l'engagement de ${e.who} : « ${e.what} » ?`) },
      depuis: e.createdAt.toISOString(),
    });
  }

  // ── LE RESTE DU CENTRE D'ACTION : à regarder, pas à signer ──────────────────────────────
  // Les tâches personnelles ne remontent que si elles pressent : la boîte n'est pas une to-do.
  for (const i of centre.lignes) {
    const j = joursAvant(i.deadline, now);
    const presse = (j !== null && j <= 3) || i.priority === "CRITICAL" || i.priority === "HIGH";
    if (i.kind === "task" && !presse) continue;
    cartes.push({
      id: `item:${i.key}`, genre: "REVIEW", sujet: i.title,
      contexte: [i.subtitle, i.owner ? `par ${i.owner}` : null].filter(Boolean).join(" · "),
      raison: `${i.statusLabel ?? "En attente"} · ${i.module}${i.deadline ? ` · ${delaiHumain(i.deadline, now)}` : ""}.`,
      echeance: i.deadline,
      urgence: urgenceDe({ genre: "REVIEW", echeance: i.deadline, priorite: i.priority }, now),
      impact: null, recommandation: null,
      options: [
        { id: "ouvrir", libelle: "Ouvrir", ton: "primaire", effet: "Ouvre la fiche dans son module.", geste: { kind: "ouvrir", href: i.href } },
        { id: "adam", libelle: "Demander à Adam", ton: "neutre", effet: "Adam résume la situation et propose la suite.", geste: { kind: "adam", phrase: i.actions?.[0]?.phrase ?? `Que dois-je faire sur « ${i.title} » ?` } },
      ],
      source: { module: i.module, libelle: i.subtitle || i.module, href: i.href },
      depuis: now.toISOString(),
    });
  }

  // ── ANOMALIES DE DONNÉES À TRANCHER (§23) ───────────────────────────────────────────────
  for (const c of qualite.lignes) {
    const options: OptionCarte[] = [];
    if (c.correction) options.push({ id: "corriger", libelle: "Corriger", ton: "primaire", effet: c.correction.description, geste: { kind: "qualite.corriger", constatId: c.id } });
    if (c.href) options.push({ id: "ouvrir", libelle: "Ouvrir la fiche", ton: "neutre", effet: "Ouvre la ligne concernée pour trancher sur place.", geste: { kind: "ouvrir", href: c.href } });
    options.push({ id: "ignorer", libelle: "Écarter", ton: "danger", effet: "Écarte ce constat avec votre motif ; il ne reviendra pas au prochain balayage.", geste: { kind: "qualite.ignorer", constatId: c.id }, saisie: { libelle: "Pourquoi ce n'est pas une anomalie", obligatoire: true } });
    cartes.push({
      id: `qualite:${c.id}`, genre: c.correction ? "CHOOSE" : "REVIEW", sujet: c.titre, contexte: tronquer(c.detail, 240),
      raison: `Anomalie ${LIBELLE_CRITICITE[c.criticite].toLowerCase()} trouvée par le moteur de qualité — ${LIBELLE_FAMILLE[c.famille as FamilleQualite] ?? c.famille}, confiance ${Math.round(c.confiance * 100)} %${c.occurrences > 1 ? `, vue ${c.occurrences} fois` : ""}.`,
      echeance: null,
      urgence: c.criticite === "CRITIQUE" ? "CRITIQUE" : "HAUTE",
      impact: c.montant != null ? formatCurrency(c.montant) : null,
      recommandation: c.correction ? { optionId: "corriger", pourquoi: c.correction.description } : null,
      options,
      source: { module: "Qualité des données", libelle: c.regle, href: "/admin/qualite" },
      depuis: c.firstSeenAt.toISOString(),
    });
  }

  // ── SIGNAUX MÉTIER À REVOIR (§27) ────────────────────────────────────────────────────────
  for (const s of intelligence.lignes) {
    const options: OptionCarte[] = [];
    if (s.href) options.push({ id: "ouvrir", libelle: "Ouvrir la fiche", ton: "primaire", effet: "Ouvre la fiche concernée pour décider sur place.", geste: { kind: "ouvrir", href: s.href } });
    options.push({ id: "expliquer", libelle: "Demander à Adam", ton: "neutre", effet: "Adam détaille le calcul et ce qu'il y a à faire.", geste: { kind: "adam", phrase: `Explique-moi ce signal et ce que je dois décider : ${s.titre}` } });
    cartes.push({
      id: `signal:${s.domaine ?? "X"}:${s.code}:${s.entite?.id ?? s.titre.slice(0, 24)}`, genre: "REVIEW", sujet: s.titre, contexte: tronquer(s.detail, 240),
      raison: `Signal ${LIBELLE_GRAVITE_SIGNAL[s.gravite]} de l'intelligence ${s.domaine === "REGULATORY" ? "Regulatory" : s.domaine === "LEGAL" ? "Legal" : "Finance"}${s.calcul ? ` — ${tronquer(s.calcul, 120)}` : ""}`,
      echeance: s.echeance ? new Date(s.echeance).toISOString() : null,
      urgence: s.gravite === "CRITIQUE" ? "CRITIQUE" : "HAUTE",
      impact: s.montant != null ? formatCurrency(s.montant) : null,
      recommandation: s.action ? { optionId: s.href ? "ouvrir" : "expliquer", pourquoi: s.action } : null,
      options,
      source: { module: s.domaine === "REGULATORY" ? "Regulatory" : s.domaine === "LEGAL" ? "Legal" : "Finances", libelle: s.code, href: s.href ?? "/aujourdhui" },
      depuis: now.toISOString(),
    });
  }

  const ordonnees = ordonner(cartes, now).slice(0, 80);
  const sources = [validations, paiements, accords, attentes, notifications, decisions, engagements, centre, qualite, intelligence].map((f) => ({ nom: f.nom, ms: f.ms, n: f.lignes.length }));
  return { cartes: ordonnees, compte: compterParGenre(ordonnees), ms: Date.now() - t0, sources };
}

/**
 * L'OUVERTURE DEPUIS UNE PAGE : la session d'abord (module Chief of Staff exigé), la boîte
 * ensuite. La page n'importe que ce pont — c'est ce qui laisse la frontière Adam ↔ ERP à son
 * plafond : composer la boîte EST connaître l'ERP, et cette connaissance vit ici, pas dans
 * l'écran.
 */
export async function ouvrirInbox(): Promise<{ user: SessionUser; vue: VueInbox }> {
  const user = await requireModule("CHIEF_OF_STAFF");
  const vue = await composerInbox(user);
  return { user, vue };
}
