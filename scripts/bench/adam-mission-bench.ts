/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE MISSIONS INÉDITES — « puis-je confier un objectif à Adam et arrêter d'y penser ? »
 *
 *   BENCH_ONLY=phare,facture npx tsx scripts/bench/adam-mission-bench.ts
 *
 * Neuf missions au wording jamais vu — vagues, multidisciplinaires, avec des dépendances, des
 * attentes, des récurrences, des humains à coordonner — lancées par le VRAI point d'entrée
 * (`lancerMission` → `avancerMission`), avec le vrai raisonneur, sur le jeu semé du banc
 * (`adam:bench:seed`). L'accord du dirigeant est donné comme il le donnerait : un clic, une fois.
 *
 * Aucun verdict binaire : chaque mission rend une CARTE — ce que le plan contenait (enquête,
 * attentes, écritures, artefacts), ce qui a été fait, ce qui a été demandé au dirigeant, où la
 * mission s'est arrêtée et pourquoi, combien elle a coûté — et une liste d'ATTENDUS par mission
 * (des booléens, pas une note) pour que deux runs se comparent. Ce qui n'est pas mesuré est dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";

interface Attendu { id: string; libelle: string; test: (c: Carte) => boolean }
interface Mission { id: string; demande: string; attendus: Attendu[] }

interface Carte {
  id: string; demande: string;
  lancee: boolean; erreur: string | null; refus: string[];
  missionId: string | null; voie: string | null; complexite: string | null; echelle: string | null;
  etapes: number; workstreams: string[]; noeuds: Record<string, number>;
  capacites: string[]; lectures: string[]; ecritures: string[];
  attentes: string[]; approbation: string | null; statut: string | null; planVersion: number | null;
  journal: Record<string, number>; notifications: string[]; replans: number;
  effets: { messages: number; taches: number; rappels: number; evenements: number; artefacts: number; surveillances: number; intents: number; intentsExecutes: number };
  appels: number; jetons: { entree: number; sortie: number; cache: number }; cout: number | null; ms: number;
  attendus: { id: string; libelle: string; ok: boolean }[];
}

const MISSIONS: Mission[] = [
  {
    id: "phare",
    demande: "En fait, je veux que tu m'exportes le suivi des dossiers regulatory et que tu inclues le pipeline avec. "
      + "Mais avant de l'exporter, demande à l'équipe regulatory de mettre à jour en urgence le statut des dossiers sur la plateforme. "
      + "Ensuite tu l'exportes pour moi et tu m'envoies un mail quand tu as fini, avec le fichier Excel. "
      + "Ensuite tu envoies un mail à Nesrine pour qu'elle t'envoie les tickets de caisse des consommations quotidiennes de café, d'eau, etc. "
      + "Chaque dimanche, tu demandes à l'équipe regulatory s'il y a des points bloquants. "
      + "Et tu crées aussi une réunion chaque jeudi avec l'équipe regulatory pour qu'on voie les différents points. "
      + "Tu demandes à Khaled de mettre à jour le budget et de vérifier que tout est bon. "
      + "Et ensuite tu demandes à Nesrine de mettre à jour l'annuaire de l'entreprise pour qu'on retrouve le téléphone ou l'e-mail de l'agence de voyage.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "attente", libelle: "une attente précède l'export (mise à jour de l'équipe)", test: (c) => c.attentes.length > 0 },
      { id: "artefact", libelle: "un livrable Excel est planifié ou produit", test: (c) => (c.noeuds.ARTIFACT ?? 0) > 0 || c.effets.artefacts > 0 },
      { id: "mail-pdg", libelle: "un e-mail au dirigeant est prévu", test: (c) => c.capacites.some((n) => /mail/.test(n)) },
      { id: "recurrence", libelle: "au moins une récurrence hebdomadaire (rappel ou réunion)", test: (c) => c.effets.rappels + c.effets.evenements > 0 },
      { id: "personnes", libelle: "des demandes nominatives partent (message/tâche/mail)", test: (c) => c.effets.messages + c.effets.taches + c.effets.intents > 0 },
      { id: "accord", libelle: "un seul accord groupé demandé", test: (c) => c.approbation !== null },
      { id: "pas-bloquee", libelle: "la mission n'est ni FAILED ni BLOCKED", test: (c) => !["FAILED", "BLOCKED"].includes(c.statut ?? "") },
    ],
  },
  {
    id: "dossier",
    demande: "Occupe-toi du dossier Trastuzumab et fais avancer le projet aussi vite que possible.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "le plan lit le dossier, les courriers ou les documents avant d'agir", test: (c) => c.lectures.length >= 2 },
      { id: "action", libelle: "une action de déblocage (message, tâche, relance) est prévue", test: (c) => c.ecritures.length > 0 },
      { id: "pas-bloquee", libelle: "la mission n'est ni FAILED ni BLOCKED", test: (c) => !["FAILED", "BLOCKED"].includes(c.statut ?? "") },
    ],
  },
  {
    id: "partenaire",
    demande: "Suis Hetero Labs jusqu'à ce qu'on obtienne le renouvellement du contrat de distribution exclusive avant son échéance.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "attente", libelle: "la mission attend une réponse ou un document", test: (c) => c.attentes.length > 0 },
      { id: "action", libelle: "une sollicitation part vers le partenaire ou le responsable", test: (c) => c.ecritures.length > 0 },
      { id: "durable", libelle: "la mission reste vivante (WAITING_*) plutôt que conclue à vide", test: (c) => /WAITING|RUNNING|AWAITING/.test(c.statut ?? "") },
    ],
  },
  {
    id: "facture",
    demande: "La facture n° 2026-0891 de l'Imprimerie El Djazaïr me semble étrange, enquête et règle ce qui peut l'être.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "facture, paiements et pièces sont lus", test: (c) => c.lectures.length >= 2 },
      { id: "conclut", libelle: "la mission conclut (COMPLETED) ou attend un arbitrage", test: (c) => ["COMPLETED", "WAITING_INPUT", "AWAITING_APPROVAL"].includes(c.statut ?? "") },
    ],
  },
  {
    id: "deblocage",
    demande: "Vérifie pourquoi le dossier Pembrolizumab n'avance plus et remets-le sur les rails.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "le blocage est cherché dans les données", test: (c) => c.lectures.length >= 1 },
      { id: "action", libelle: "une action de remise sur les rails est prévue", test: (c) => c.ecritures.length > 0 },
    ],
  },
  {
    id: "surveillance",
    demande: "Surveille l'appel d'offres PCH 2026/14 et préviens-moi seulement s'il y a un problème.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "veille", libelle: "une attente durable (événement, échéance ou surveillance) est posée", test: (c) => c.attentes.length + c.effets.surveillances > 0 },
      // Une ligne JOURNAL (centre de notifications, sans push ni e-mail) n'interrompt personne :
      // c'est la trace, pas l'alerte. Le silence se mesure sur ce qui dérange (INFO et au-delà).
      { id: "silence", libelle: "le dirigeant n'est pas dérangé sans problème avéré (rien au-dessus de JOURNAL, hors accord)", test: (c) => c.notifications.filter((n) => !/accord/i.test(n) && !/^JOURNAL/.test(n)).length === 0 },
    ],
  },
  {
    id: "negociation",
    demande: "Prépare la négociation avec Hetero Labs : je veux de meilleures conditions sans compromettre le partenariat.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "contrat, historique et échanges sont lus", test: (c) => c.lectures.length >= 2 },
      { id: "aucune-externe", libelle: "aucune communication externe n'est envoyée", test: (c) => !c.ecritures.some((n) => /send_prepared_mail|send_email/.test(n)) },
      { id: "conclut", libelle: "un brief est produit (COMPLETED ou artefact)", test: (c) => c.statut === "COMPLETED" || c.effets.artefacts > 0 },
    ],
  },
  {
    id: "engagements",
    demande: "Assure-toi que les engagements pris au dernier comité de direction sont tenus.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "le compte rendu ou les engagements sont lus", test: (c) => c.lectures.length >= 1 },
      { id: "suivi", libelle: "un suivi (attente, rappel ou relance) est posé", test: (c) => c.attentes.length + c.effets.rappels + c.ecritures.length > 0 },
    ],
  },
  {
    id: "echeances",
    demande: "Fais en sorte qu'on ne rate aucune échéance réglementaire critique ce mois-ci.",
    attendus: [
      { id: "lancee", libelle: "mission créée", test: (c) => c.lancee },
      { id: "enquete", libelle: "les dossiers et échéances sont lus", test: (c) => c.lectures.length >= 1 },
      { id: "suivi", libelle: "un suivi durable est posé", test: (c) => c.attentes.length + c.effets.rappels > 0 },
    ],
  },
];

const ECRITURE = (n: string): boolean =>
  /^(send_|create_|update_|plan_|assign_|set_|cancel_|snooze_|delete_|schedule_|record_|mark_|close_|reply_|forward_)/.test(n) || /_operation$/.test(n) || /^gmail_(prepare|send)/.test(n);

function attenteTexte(w: unknown): string | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const parts: string[] = [];
  if (o.event) parts.push(String(o.event));
  if (o.ask) parts.push(`ask:${String(o.ask).slice(0, 40)}`);
  if (o.from) parts.push(`de ${String(o.from)}`);
  if (o.withinDays) parts.push(`≤${String(o.withinDays)}j`);
  if (o.until) parts.push(`jusqu'au ${String(o.until).slice(0, 10)}`);
  if (Array.isArray(o.anyOf)) parts.push(`OU(${o.anyOf.length})`);
  if (Array.isArray(o.allOf)) parts.push(`ET(${o.allOf.length})`);
  return parts.length ? parts.join(" ") : JSON.stringify(o).slice(0, 60);
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { getAccess } = await import("@/lib/rbac");
  const { lancerMission, finaliserLancementDifere } = await import("@/platform/in-process/missions/runtime");
  const { conduireMission } = await import("@/platform/in-process/missions/sweep");
  const { decider } = await import("@/lib/missions/approval/gate");
  const { chargerEtat } = await import("@/lib/missions/runtime/store");
  const { viderTampon } = await import("@/platform/ia/telemetry/usage-sink");
  const { VERITES } = await import("./seed-adam-bench");
  type CurrentUser = import("@/lib/session").CurrentUser;

  const row = await prisma.user.findUnique({ where: { email: VERITES.pdg.email } });
  if (!row) throw new Error("Compte du banc absent : semer d'abord (BENCH_SEED_ALLOW=1 npm run adam:bench:seed)");
  const pdg: CurrentUser = {
    id: row.id, name: row.name, email: row.email, role: row.role, secondaryRole: row.secondaryRole,
    mustChangePassword: row.mustChangePassword, access: await getAccess(row.id, row.role),
  } as unknown as CurrentUser;

  const only = (process.env.BENCH_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const missions = only.length ? MISSIONS.filter((m) => only.includes(m.id)) : MISSIONS;
  const tours = Math.max(1, Number(process.env.BENCH_TOURS ?? "8") || 8);
  const tag = process.env.BENCH_TAG ?? "missions";
  const cartes: Carte[] = [];

  for (const m of missions) {
    const t0 = Date.now();
    const depuis = new Date();
    console.log(`\n══════════ ${m.id} — ${m.demande.slice(0, 110)}${m.demande.length > 110 ? "…" : ""}`);
    const c: Carte = {
      id: m.id, demande: m.demande, lancee: false, erreur: null, refus: [], missionId: null, voie: null, complexite: null, echelle: null,
      etapes: 0, workstreams: [], noeuds: {}, capacites: [], lectures: [], ecritures: [], attentes: [], approbation: null, statut: null, planVersion: null,
      journal: {}, notifications: [], replans: 0,
      effets: { messages: 0, taches: 0, rappels: 0, evenements: 0, artefacts: 0, surveillances: 0, intents: 0, intentsExecutes: 0 },
      appels: 0, jetons: { entree: 0, sortie: 0, cache: 0 }, cout: null, ms: 0, attendus: [],
    };
    try {
      let r = await lancerMission(pdg, m.demande, { titre: `[BENCH ${tag}] ${m.id}` });
      // LE REPLI SUR TALON, rattrapé ici comme le battement le ferait (trois tentatives).
      for (let essai = 1; r.ok && r.differe && essai <= 3; essai += 1) {
        console.log(`  · planification différée (panne transitoire) — reprise ${essai}/3 dans 5 s`);
        await new Promise((res) => setTimeout(res, 5_000));
        const f = await finaliserLancementDifere(r.missionId, pdg, m.demande, { titre: `[BENCH ${tag}] ${m.id}` });
        if (f.finalise) {
          const mrow = await prisma.mission.findUnique({ where: { id: r.missionId }, select: { complexity: true, scale: true } });
          const etapes = await prisma.missionStep.count({ where: { missionId: r.missionId } });
          const appro = await prisma.missionApproval.findFirst({ where: { missionId: r.missionId, status: "PENDING" }, select: { id: true, level: true, summary: true } });
          r = { ...r, differe: false, etapes, complexite: mrow?.complexity ?? "?", echelle: mrow?.scale ?? "?", approbation: appro ? { id: appro.id, niveau: appro.level, resume: appro.summary } : null };
          break;
        }
        console.log(`  · reprise ${essai} : ${f.raison ?? "non finalisée"}`);
      }
      if (r.ok && r.differe) { c.lancee = true; c.missionId = r.missionId; c.erreur = "planification différée non aboutie (3 reprises)"; console.log(`  ✗ ${c.erreur}`); }
      else if (!r.ok) {
        c.erreur = r.error; c.refus = (r.refus ?? []).map((i) => `${i.code} ${i.stepKey ?? ""}: ${i.message}`);
        console.log(`  ✗ non lancée : ${r.error}`); for (const x of c.refus) console.log(`    · ${x}`);
      } else {
        c.lancee = true; c.missionId = r.missionId; c.voie = r.metriques.voie; c.complexite = r.complexite; c.echelle = r.echelle;
        c.approbation = r.approbation ? `${r.approbation.niveau} — ${r.approbation.resume.slice(0, 120)}` : null;
        console.log(`  ✓ lancée ${r.missionId} · voie ${r.metriques.voie} · ${r.etapes} étapes · ${r.complexite}/${r.echelle} · plan ${r.metriques.latencyMs} ms · accord ${r.approbation?.niveau ?? "aucun"}`);
        if (r.gaps.length) console.log(`  · lacunes annoncées : ${r.gaps.join(" ; ")}`);
        if (r.approbation) {
          const ok = await decider(r.approbation.id, "GRANTED", pdg.id);
          console.log(`  · accord donné (clic simulé) : ${ok}`);
        }
        // Conduire jusqu'à un état stable — LE GESTE DU BATTEMENT, en boucle : avancer, replanifier
        // si ça coince, signaler si ça coince encore (`conduireMission`, ce que `balayerMissions`
        // fait en production). Mesurer avec `avancerMission` seul sous-estimait le système : une
        // étape en échec définitif restait BLOCKED là où le battement aurait replanifié.
        let precedent = "";
        for (let i = 0; i < tours; i += 1) {
          const tick = await conduireMission(pdg, r.missionId, { maxTours: 25 }).catch((e) => { console.log(`  · tour ${i + 1} en erreur : ${String(e).slice(0, 120)}`); return null; });
          const etat = await chargerEtat(r.missionId);
          if (!etat) break;
          const sig = `${etat.status}|${etat.steps.map((s) => `${s.key}:${s.status}`).sort().join(",")}`;
          console.log(`  · tour ${i + 1} : ${etat.status} · exécutées ${tick?.executees ?? "?"} · déployées ${tick?.deployees ?? "?"}${tick?.replanifie ? " · REPLANIFIÉE" : ""}${tick?.signale ? " · dirigeant signalé" : ""}`);
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(etat.status)) break;
          if (sig === precedent) break;
          precedent = sig;
        }
      }
    } catch (e) {
      c.erreur = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ exception : ${c.erreur.slice(0, 200)}`);
    }
    c.ms = Date.now() - t0;

    // ── LA CARTE — lue en base, jamais déduite du journal de console ──────────────────────
    if (c.missionId) {
      const etat = await chargerEtat(c.missionId);
      const mrow = await prisma.mission.findUnique({ where: { id: c.missionId }, select: { status: true, planVersion: true } });
      c.statut = mrow?.status ?? null; c.planVersion = mrow?.planVersion ?? null;
      if (etat) {
        const actives = etat.steps.filter((s) => !s.contournee);
        c.etapes = actives.length;
        c.workstreams = [...new Set(actives.map((s) => s.workstream))];
        for (const s of actives) c.noeuds[s.nodeType] = (c.noeuds[s.nodeType] ?? 0) + 1;
        const caps = actives.map((s) => s.capability).filter((x): x is string => Boolean(x));
        c.capacites = [...new Set(caps)];
        c.lectures = c.capacites.filter((n) => !ECRITURE(n));
        c.ecritures = c.capacites.filter(ECRITURE);
        c.attentes = actives.filter((s) => s.nodeType === "WAIT_EVENT" || s.nodeType === "WAIT_INPUT").map((s) => `${s.key}[${s.status}] ${attenteTexte(s.waitFor) ?? "?"}`);
      }
      const events = await prisma.missionEvent.findMany({ where: { missionId: c.missionId }, select: { kind: true, summary: true }, orderBy: { at: "asc" } });
      for (const e of events) c.journal[e.kind] = (c.journal[e.kind] ?? 0) + 1;
      c.notifications = events.filter((e) => e.kind === "NOTIFIED").map((e) => e.summary.slice(0, 100));
      c.replans = c.journal.REPLANNED ?? 0;
      const intents = await prisma.assistantActionIntent.findMany({ where: { missionId: c.missionId }, select: { status: true } });
      c.effets.intents = intents.length; c.effets.intentsExecutes = intents.filter((i) => i.status === "EXECUTED").length;
      const [messages, taches, rappels, evenements, artefacts, surveillances] = await Promise.all([
        prisma.message.count({ where: { senderId: pdg.id, createdAt: { gte: depuis } } }),
        prisma.task.count({ where: { createdById: pdg.id, createdAt: { gte: depuis } } }),
        prisma.reminder.count({ where: { OR: [{ createdById: pdg.id }, { userId: pdg.id }], createdAt: { gte: depuis } } }),
        prisma.calendarEvent.count({ where: { createdById: pdg.id, createdAt: { gte: depuis } } }),
        prisma.driveNode.count({ where: { createdById: pdg.id, createdAt: { gte: depuis }, NOT: { mimeType: null } } }),
        // Une surveillance durable est une attente qui vit HORS de la mission qui l'a posée
        // (mission-support WATCH + AdamWatch) : la compter ici, sinon « veille » ne la voit pas.
        prisma.adamWatch.count({ where: { ownerId: pdg.id, createdAt: { gte: depuis } } }),
      ]);
      c.effets = { ...c.effets, messages, taches, rappels, evenements, artefacts, surveillances };
      await viderTampon();
      const appels = await prisma.modelCallLog.findMany({ where: { missionId: c.missionId }, select: { inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true } });
      c.appels = appels.length;
      c.jetons = { entree: appels.reduce((a, x) => a + x.inputTokens, 0), sortie: appels.reduce((a, x) => a + x.outputTokens, 0), cache: appels.reduce((a, x) => a + x.cachedInputTokens, 0) };
      c.cout = appels.every((x) => x.costUsd !== null) ? appels.reduce((a, x) => a + Number(x.costUsd ?? 0), 0) : null;
    }
    c.attendus = m.attendus.map((a) => ({ id: a.id, libelle: a.libelle, ok: a.test(c) }));
    cartes.push(c);

    console.log(`  → statut ${c.statut ?? "—"} · plan v${c.planVersion ?? "?"} · ${c.etapes} étapes · nœuds ${JSON.stringify(c.noeuds)}`);
    console.log(`  → lectures [${c.lectures.join(", ")}]`);
    console.log(`  → écritures [${c.ecritures.join(", ")}]`);
    if (c.attentes.length) console.log(`  → attentes : ${c.attentes.join(" | ")}`);
    console.log(`  → effets : ${JSON.stringify(c.effets)} · journal ${JSON.stringify(c.journal)}`);
    if (c.notifications.length) console.log(`  → dirigeant notifié : ${c.notifications.join(" || ")}`);
    console.log(`  → ${c.appels} appel(s) · ${c.jetons.entree}/${c.jetons.sortie} jetons (cache ${c.jetons.cache}) · ${c.cout == null ? "coût inconnu" : `$${c.cout.toFixed(4)}`} · ${(c.ms / 1000).toFixed(1)} s`);
    console.log(`  → attendus : ${c.attendus.map((a) => `${a.ok ? "✓" : "✗"} ${a.id}`).join("  ")}`);
  }

  // ── LE TABLEAU ────────────────────────────────────────────────────────────────────────────
  console.log("\n| Mission | Statut | Étapes | Attentes | Écritures | Notif. | Appels | Jetons | Coût | Durée | Attendus |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  let okTot = 0, nTot = 0;
  for (const c of cartes) {
    const ok = c.attendus.filter((a) => a.ok).length; okTot += ok; nTot += c.attendus.length;
    console.log(`| ${c.id} | ${c.statut ?? (c.lancee ? "?" : "NON LANCÉE")} | ${c.etapes} | ${c.attentes.length} | ${c.ecritures.length} | ${c.notifications.length} | ${c.appels} | ${c.jetons.entree} | ${c.cout == null ? "?" : `$${c.cout.toFixed(3)}`} | ${(c.ms / 1000).toFixed(0)} s | ${ok}/${c.attendus.length} |`);
  }
  console.log(`\nAttendus satisfaits : ${okTot}/${nTot} (${nTot ? Math.round((100 * okTot) / nTot) : 0} %) · coût total ${cartes.every((c) => c.cout !== null) ? `$${cartes.reduce((a, c) => a + (c.cout ?? 0), 0).toFixed(4)}` : "partiellement inconnu"}`);
  const dir = path.join(process.cwd(), "bench-out");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `adam-missions-${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(cartes, null, 2));
  console.log(`JSON : ${out}`);
  await prisma.$disconnect();
}

if (process.argv[1] && /adam-mission-bench\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
