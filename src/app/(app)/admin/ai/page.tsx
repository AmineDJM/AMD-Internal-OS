import { BrainCircuit, KeyRound, CheckCircle2, XCircle, Activity, Mic, HeartPulse } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { aiConfigured, sttConfigured, aiModel, cleModeleRequise, fournisseurDeRaisonnement } from "@/lib/ai";
import { realtimeVoiceConfigured, REALTIME_VOICE_MODEL } from "@/lib/assistant/voice-realtime";
import { getLatestAiHealth } from "@/lib/ai-health";
import { getAiSettings, type AiFeature } from "@/lib/ai-settings";
import { parityStats } from "@/lib/assistant/action-registry";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ADMIN_TABS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatDateTime } from "@/lib/utils";
import { AiSettingsForm } from "./ai-settings-form";
import { AiHealthCheckButton } from "./health-check-button";
import { adamHealth, type HealthLevel } from "@/lib/google/health";
import { statistiquesCout, fmtUsd } from "@/platform/in-process/telemetry/usage-stats";
import { allBindings } from "@/lib/models/registry";

export const metadata = { title: "Centre de contrôle IA — AMD Internal OS" };
export const dynamic = "force-dynamic";

// Une fonction par bascule, et chacune son libellé : `Record<AiFeature, …>` fait qu'une fonction ajoutée demain
// ne compile pas sans le sien (vague « restes » — « Rédiger avec l'IA » et la lecture des pièces s'affichaient
// sous leur identifiant brut). Les journaux portent aussi des fonctions hors de cette liste : elles gardent
// leur nom tel quel.
const FEATURE_LABEL: Record<AiFeature, string> = {
  assistant: "Assistant IA",
  nudge: "Suggestions proactives",
  brain: "Adventum Brain",
  briefing: "Briefing direction",
  process_intel: "Process Intelligence",
  field_report: "Rapports terrain",
  voice: "Transcription vocale",
  voice_realtime: "Voix temps réel",
  site_web: "Rédaction du site web",
  lecture_pieces: "Lecture des pièces déposées",
  conseil_pieces: "Luna — rangement des pièces Ad & Pro",
  kpi: "Luna — KPI & bilans",
  voix_terrain: "Luna — la voix du terrain (cockpits)",
  produit_360: "Luna — l'essentiel d'un produit (Produits 360)",
  budget_campagne: "Luna — campagne budgétaire (justifications, versions)",
  influence: "Luna — graphe d'influence (Intelligence terrain)",
  attestation_travail: "Luna — attestation de travail (lecture du contrat)",
};
const libelleFonction = (f: string): string => (FEATURE_LABEL as Record<string, string>)[f] ?? f;

export default async function AiControlCenterPage() {
  const user = await requireModule("ADMIN", "UPDATE");
  const settings = await getAiSettings();

  const since30 = new Date(Date.now() - 30 * 86400000);
  const since7 = new Date(Date.now() - 7 * 86400000);

  const [total30, ok30, total7, byFeature, okByFeature, recentFailures] = await Promise.all([
    prisma.aiUsageLog.count({ where: { createdAt: { gte: since30 } } }),
    prisma.aiUsageLog.count({ where: { createdAt: { gte: since30 }, ok: true } }),
    prisma.aiUsageLog.count({ where: { createdAt: { gte: since7 } } }),
    prisma.aiUsageLog.groupBy({ by: ["feature"], where: { createdAt: { gte: since30 } }, _count: { _all: true }, _avg: { latencyMs: true } }),
    prisma.aiUsageLog.groupBy({ by: ["feature"], where: { createdAt: { gte: since30 }, ok: true }, _count: { _all: true } }),
    prisma.aiUsageLog.findMany({ where: { ok: false, createdAt: { gte: since30 } }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  // LATENCES RÉELLES : p50/p95 par fonction (30 j) — la moyenne cache les queues, les
  // percentiles les montrent. Calculées EN BASE (percentile_cont), jamais en mémoire.
  const percentiles = await prisma.$queryRaw<{ feature: string; p50: number | null; p95: number | null }[]>`
    SELECT "feature",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS "p50",
           percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS "p95"
    FROM "AiUsageLog"
    WHERE "createdAt" >= ${since30} AND "latencyMs" IS NOT NULL
    GROUP BY "feature"
  `.catch(() => [] as { feature: string; p50: number | null; p95: number | null }[]);
  const pMap = new Map(percentiles.map((r) => [r.feature, { p50: r.p50 ? Math.round(Number(r.p50)) : null, p95: r.p95 ? Math.round(Number(r.p95)) : null }]));

  // L'ÉTAT DES ACTIONS (7 j) : intentions proposées / exécutées / échouées / annulées —
  // la machine d'état canonique vue d'en haut.
  const intentCounts = await prisma.assistantActionIntent.groupBy({
    by: ["status"],
    where: { proposedAt: { gte: since7 } },
    _count: { _all: true },
  }).catch(() => [] as { status: string; _count: { _all: number } }[]);
  const intentOf = (s: string) => intentCounts.find((r) => r.status === s)?._count._all ?? 0;

  // LA PARITÉ UI ↔ CHIEF — la métrique du registre ZERO-GAP (calcul pur, aucun appel IA).
  const parity = parityStats();

  const okMap = new Map(okByFeature.map((r) => [r.feature, r._count._all]));
  const features = byFeature
    .map((r) => ({
      feature: r.feature,
      label: libelleFonction(r.feature),
      total: r._count._all,
      ok: okMap.get(r.feature) ?? 0,
      avgMs: r._avg.latencyMs ? Math.round(r._avg.latencyMs) : null,
      p50: pMap.get(r.feature)?.p50 ?? null,
      p95: pMap.get(r.feature)?.p95 ?? null,
    }))
    .sort((a, b) => b.total - a.total);

  // Noms des utilisateurs pour les derniers échecs.
  const userIds = [...new Set(recentFailures.map((f) => f.userId).filter(Boolean))] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const successRate = total30 > 0 ? Math.round((ok30 / total30) * 100) : null;

  // Santé de l'API IA — dernière sonde quotidienne (le chatbot en dépend directement).
  const health = await getLatestAiHealth();

  // LE COÛT — la métrique de premier rang : où part l'argent, par modèle, par usage, par personne,
  // par tour et par mission. Agrégé en base ; « inconnu » quand un tarif manque, jamais zéro.
  const cout = await statistiquesCout(30).catch(() => null);
  const liaisons = allBindings();
  const coutUsers = cout && cout.parPersonne.length
    ? await prisma.user.findMany({ where: { id: { in: cout.parPersonne.map((p) => p.userId) } }, select: { id: true, name: true } })
    : [];
  const nomDe = new Map(coutUsers.map((u) => [u.id, u.name]));
  const pctCache = (c: { entree: number; cache: number }) => (c.entree > 0 ? `${Math.round((100 * c.cache) / c.entree)} %` : "—");
  const totalAffiche = (c: { coutUsd: number; sansTarif: number }) => (c.sansTarif > 0 ? `${fmtUsd(c.coutUsd, 2)} + ${c.sansTarif} appel(s) sans tarif` : fmtUsd(c.coutUsd, 2));

  // Santé des canaux Google d'Adam. Le calcul est partagé avec les réglages du PDG : deux
  // sources donneraient tôt ou tard deux vérités. Ne lève jamais — cette page doit s'afficher
  // même quand Google est en panne, sinon on perd l'écran qui sert justement à le diagnostiquer.
  const adam = await adamHealth().catch(() => null);

  return (
    <div className="space-y-5">
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><BrainCircuit className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Centre de contrôle IA</h1>
          <p className="text-sm text-muted-foreground">Activez ou coupez l'IA par fonction, et suivez son usage. Réservé au Super Admin.</p>
        </div>
      </div>

      {/* État des clés / configuration (lecture seule, posées sur Render). */}
      <Card>
        <CardHeader><CardTitle>Configuration & clés</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/*
            LE FOURNISSEUR ACTIF, PAS UN NOM GRAVÉ. L'étiquette disait « Claude (Anthropic) » et
            nommait la clé du mauvais fournisseur sur un déploiement qui tourne chez OpenAI : un
            administrateur cherchant la panne serait allé poser la mauvaise variable. Le nom vient
            donc du registre (`cleModeleRequise`), et le littéral ne reparaît dans AUCUN écran —
            le cliquet de §118.128 le refuse, et il refuserait cette phrase si elle le citait.
          */}
          <KeyStatus
            icon={<KeyRound className="h-4 w-4" />}
            label={`Modèle de raisonnement (${fournisseurDeRaisonnement()})`}
            ok={aiConfigured()}
            detail={aiConfigured() ? `Modèle : ${aiModel()}` : `${cleModeleRequise()} absente`}
          />
          <KeyStatus
            icon={<Mic className="h-4 w-4" />}
            label="Dictée — transcription (OpenAI)"
            ok={sttConfigured()}
            detail={sttConfigured() ? `Modèle : ${process.env.STT_MODEL ?? "whisper-1"}` : "OPENAI_API_KEY absente"}
          />
          <KeyStatus
            icon={<Mic className="h-4 w-4" />}
            label="Voix temps réel — Chief of Staff"
            ok={realtimeVoiceConfigured()}
            detail={realtimeVoiceConfigured()
              ? `Modèle : ${REALTIME_VOICE_MODEL} (WebRTC, secret éphémère — sessions journalisées dans l'usage, fonction « voice_realtime »)`
              : "OPENAI_API_KEY absente"}
          />
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Les clés sont des secrets serveur (jamais exposés au client) et se définissent dans les variables
            d'environnement Render — pas ici. Cette page contrôle uniquement l'activation des fonctions.
          </p>
        </CardContent>
      </Card>

      {/* Santé de l'API (sonde quotidienne automatique + test à la demande) */}
      <Card>
        <CardHeader><CardTitle>Santé du chatbot IA — test automatique quotidien</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2">
              <HeartPulse className={`h-5 w-5 ${!health ? "text-muted-foreground" : health.ok ? "text-success" : "text-destructive"}`} />
              {!health ? (
                <Badge tone="neutral" dot={false}>Aucun test encore effectué</Badge>
              ) : health.ok ? (
                <Badge tone="success" dot={false}>API opérationnelle</Badge>
              ) : (
                <Badge tone="danger" dot={false}>API indisponible</Badge>
              )}
            </span>
            {health && (
              <span className="text-xs text-muted-foreground">
                Dernier test : {formatDateTime(health.checkedAt)} · {health.model}
                {health.latencyMs != null ? ` · ${health.latencyMs} ms` : ""}
                {health.status != null ? ` · HTTP ${health.status}` : ""}
              </span>
            )}
          </div>
          {health && !health.ok && health.error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
              <span className="font-semibold">Souci détecté :</span> {health.error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            L'API IA est testée <strong>automatiquement une fois par jour</strong> ; en cas de panne, tous les Super Admins
            reçoivent une notification avec le message exact du problème (clé, crédit, réseau).
          </p>
          <AiHealthCheckButton />
        </CardContent>
      </Card>

      {/* ADAM — la vue d'EXPLOITATION : pourquoi ça ne marche pas, pas « est-ce que ça marche ».
          Les réglages du PDG vivent dans /chief-of-staff/reglages ; ici on regarde la plomberie. */}
      {adam && (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Adam — canaux Google
            <Badge tone={ADAM_TONE[adam.level]} dot>{ADAM_LABEL[adam.level]}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {adam.issues.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {adam.issues.map((i) => (
                <li key={i}>• {i}</li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Compte" value={adam.connection.address ?? "aucun"} />
            <Metric label="Jeton de reprise" value={adam.connection.hasRefreshToken ? "présent" : "absent"} />
            <Metric label="Droits manquants" value={String(adam.connection.missingScopes.length)} />
            <Metric label="Sujet Pub/Sub" value={adam.config.pubsubTopic ? "configuré" : "absent"} />
            <Metric label="Veille armée jusqu'au" value={adam.watch.expiresAt ? formatDateTime(adam.watch.expiresAt) : "—"} />
            <Metric label="Dernier push reçu" value={adam.ingestion.lastNotifiedAt ? formatDateTime(adam.ingestion.lastNotifiedAt) : "jamais"} />
            <Metric label="Dernière réconciliation" value={adam.ingestion.lastReconciledAt ? formatDateTime(adam.ingestion.lastReconciledAt) : "jamais"} />
            <Metric label="Point d'histoire" value={adam.ingestion.hasHistoryMarker ? "posé" : "absent"} />
            <Metric label="Messages reçus (24 h)" value={formatNumber(adam.ingestion.last24h)} />
            <Metric label="Politique d'envoi" value={adam.outbound.policy} />
            <Metric label="En attente d'accord" value={formatNumber(adam.outbound.awaitingApproval)} />
            <Metric label="Approuvés non partis" value={formatNumber(adam.outbound.approvedNotSent)} />
            <Metric label="Envoyés (24 h)" value={formatNumber(adam.outbound.sent24h)} />
            <Metric label="Échecs d'envoi (24 h)" value={formatNumber(adam.outbound.failed24h)} />
            <Metric label="Missions en attente" value={formatNumber(adam.missions.waiting)} />
            <Metric label="Missions prêtes à envoyer" value={formatNumber(adam.missions.readyToSend)} />
          </div>
        </CardContent>
      </Card>
      )}

      {/* Bascules d'activation */}
      <Card>
        <CardHeader><CardTitle>Activation par fonction</CardTitle></CardHeader>
        <CardContent>
          <AiSettingsForm initial={settings} />
        </CardContent>
      </Card>

      {/* COÛT — où part l'argent. Lu dans ModelCallLog (une ligne par appel) et AiUsageLog (une
          ligne par tour). Un tarif inconnu s'affiche comme tel : jamais un zéro qui aurait l'air
          d'un prix. */}
      {cout && (
      <Card>
        <CardHeader><CardTitle>Coût des modèles (30 jours)</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><p className="break-words text-xl font-semibold tabular-nums sm:text-2xl">{totalAffiche(cout.total)}</p><p className="text-xs text-muted-foreground">30 jours · {formatNumber(cout.total.appels)} appels · cache {pctCache(cout.total)}</p></div>
            <div><p className="break-words text-xl font-semibold tabular-nums sm:text-2xl">{totalAffiche(cout.aujourdHui)}</p><p className="text-xs text-muted-foreground">aujourd&apos;hui · {formatNumber(cout.aujourdHui.appels)} appels</p></div>
            <div><p className="break-words text-xl font-semibold tabular-nums sm:text-2xl">{fmtUsd(cout.parTour.moyenUsd)}</p><p className="text-xs text-muted-foreground">par tour de conversation (moy.) · p50 {fmtUsd(cout.parTour.p50Usd)} · p95 {fmtUsd(cout.parTour.p95Usd)}{cout.parTour.toursSansTarif > 0 ? ` · ${cout.parTour.toursSansTarif} tour(s) sans tarif` : ""}</p></div>
            <div><p className="break-words text-xl font-semibold tabular-nums sm:text-2xl">{cout.missions.moyenUsd == null ? "—" : fmtUsd(cout.missions.moyenUsd)}</p><p className="text-xs text-muted-foreground">par mission (moy.) · {formatNumber(cout.missions.missions)} mission(s) · {totalAffiche(cout.missions)}</p></div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Par modèle</p>
              {cout.parModele.length === 0 ? <p className="text-sm text-muted-foreground">Aucun appel enregistré.</p> : (
                <ul className="space-y-1 text-sm">
                  {cout.parModele.map((m) => (
                    <li key={m.cle} className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 truncate font-medium">{m.cle}</span>
                      <span className="ml-auto text-right text-muted-foreground tabular-nums">{fmtUsd(m.coutUsd, 2)}{m.sansTarif > 0 ? " (+ inconnu)" : ""} · {formatNumber(m.appels)} · cache {pctCache(m)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Par usage</p>
              {cout.parUsage.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
                <ul className="space-y-1 text-sm">
                  {cout.parUsage.map((u) => (
                    <li key={u.cle} className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{u.cle}</span>
                      <span className="ml-auto text-right text-muted-foreground tabular-nums">{fmtUsd(u.coutUsd, 2)}{u.sansTarif > 0 ? " (+ inconnu)" : ""} · {formatNumber(u.appels)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Par personne</p>
              {cout.parPersonne.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
                <ul className="space-y-1 text-sm">
                  {cout.parPersonne.map((u) => (
                    <li key={u.userId} className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 truncate font-medium">{nomDe.get(u.userId) ?? (u.userId === "—" ? "hors conversation (battement, missions de fond)" : u.userId)}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{fmtUsd(u.coutUsd, 2)} · {formatNumber(u.appels)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tarifs en vigueur (par million de jetons)</p>
            <ul className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
              {liaisons.map((b) => (
                <li key={b.role}><span className="font-medium text-foreground">{b.role}</span> → {b.model} · {b.priceInPerM == null ? "tarif inconnu" : `${b.priceInPerM} $ / ${b.priceOutPerM} $${b.priceCachedInPerM != null ? ` · cache ${b.priceCachedInPerM} $` : ""}`} · effort {b.reasoning}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted-foreground">Un tarif se corrige sans redéploiement (variables ADAM_PRICE_*). Un appel sans tarif rend le total « inconnu » : on ne présente jamais un total partiel comme un total.</p>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Usage */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Appels (30 j)" value={formatNumber(total30)} icon={<Activity className="h-4 w-4" />} />
        <Stat label="Appels (7 j)" value={formatNumber(total7)} icon={<Activity className="h-4 w-4" />} />
        <Stat label="Taux de succès (30 j)" value={successRate === null ? "—" : `${successRate}%`} icon={<CheckCircle2 className="h-4 w-4" />} />
      </div>

      {/* PARITÉ UI ↔ CHIEF — la métrique du registre ZERO-GAP : combien de boutons métier de
          l'ERP le Chief sait faire nativement. Calcul PUR (registre versionné), zéro appel IA ;
          le cliquet CI (action-parity.test) empêche tout recul silencieux. */}
      <Card>
        <CardHeader><CardTitle>Parité UI ↔ Chief of Staff</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div><p className="text-2xl font-semibold">{parity.parityPct}%</p><p className="text-xs text-muted-foreground">parité (couvert / pertinent)</p></div>
            <div><p className="text-2xl font-semibold">{parity.native + parity.covered}</p><p className="text-xs text-muted-foreground">actions couvertes</p></div>
            <div><p className="text-2xl font-semibold">{parity.gap}</p><p className="text-xs text-muted-foreground">trous assumés</p></div>
            <div><p className="text-2xl font-semibold">{parity.excluded}</p><p className="text-xs text-muted-foreground">exclues (sécurité/technique)</p></div>
            <div><p className="text-2xl font-semibold">{parity.total}</p><p className="text-xs text-muted-foreground">actions classées</p></div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Chaque action serveur de l'ERP est classée (native / couverte / trou assumé / exclue) dans un registre versionné ;
            un test CI (cliquet) refuse qu'un trou s'ouvre en silence.
          </p>
        </CardContent>
      </Card>

      {/* ACTIONS DU CHIEF (7 j) — la machine d'état canonique vue d'en haut : proposé n'est pas
          exécuté, et chaque exécution a son reçu. */}
      <Card>
        <CardHeader><CardTitle>Actions du Chief (7 jours)</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div><p className="text-2xl font-semibold">{intentOf("PROPOSED")}</p><p className="text-xs text-muted-foreground">proposées (en attente)</p></div>
            <div><p className="text-2xl font-semibold">{intentOf("EXECUTED")}</p><p className="text-xs text-muted-foreground">exécutées (avec reçu)</p></div>
            <div><p className="text-2xl font-semibold">{intentOf("FAILED")}</p><p className="text-xs text-muted-foreground">échouées</p></div>
            <div><p className="text-2xl font-semibold">{intentOf("CANCELLED")}</p><p className="text-xs text-muted-foreground">annulées</p></div>
            <div><p className="text-2xl font-semibold">{intentOf("EXPIRED")}</p><p className="text-xs text-muted-foreground">expirées</p></div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            États canoniques serveur (AssistantActionIntent) : une action PROPOSÉE n'a jamais été exécutée ; seule EXÉCUTÉE vaut envoi réel.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Usage par fonction (30 jours)</CardTitle></CardHeader>
        <CardContent>
          {features.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun appel IA enregistré sur la période.</p>
          ) : (
            <div className="space-y-2.5">
              {features.map((f) => {
                const rate = f.total > 0 ? Math.round((f.ok / f.total) * 100) : 0;
                return (
                  <div key={f.feature} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm sm:flex-nowrap">
                    <span className="basis-full font-medium sm:w-44 sm:shrink-0 sm:basis-auto">{f.label}</span>
                    <div className="h-2 min-w-[5rem] flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className={rate >= 90 ? "h-full bg-success" : rate >= 60 ? "h-full bg-warning" : "h-full bg-destructive"} style={{ width: `${rate}%` }} />
                    </div>
                    <span className="max-w-[60%] shrink-0 text-right text-xs text-muted-foreground sm:w-32 sm:max-w-none sm:text-sm">
                      {formatNumber(f.total)} appels · {rate}%{f.p50 ? ` · p50 ${f.p50}ms` : f.avgMs ? ` · ${f.avgMs}ms` : ""}{f.p95 ? ` · p95 ${f.p95}ms` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Derniers échecs IA</CardTitle></CardHeader>
        <CardContent>
          {recentFailures.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun échec récent. 👌</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {recentFailures.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                    <span className="font-medium">{libelleFonction(f.feature)}</span>
                    <span className="text-muted-foreground">{f.errorCode ?? "erreur"}</span>
                    {f.userId && <span className="text-xs text-muted-foreground">· {nameOf.get(f.userId) ?? "—"}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(f.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KeyStatus({ icon, label, ok, detail }: { icon: React.ReactNode; label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>
        </div>
      </div>
      {ok ? <Badge tone="success" dot={false} className="shrink-0">Configurée</Badge> : <Badge tone="danger" dot={false} className="shrink-0">Absente</Badge>}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold">{value}</p>
        </div>
        <span className="text-muted-foreground">{icon}</span>
      </CardContent>
    </Card>
  );
}

const ADAM_TONE: Record<HealthLevel, "success" | "warning" | "danger" | "neutral"> = {
  OPERATIONAL: "success",
  DEGRADED: "warning",
  DISCONNECTED: "neutral",
  MISCONFIGURED: "danger",
};

const ADAM_LABEL: Record<HealthLevel, string> = {
  OPERATIONAL: "Operationnel",
  DEGRADED: "Degrade",
  DISCONNECTED: "Non connecte",
  MISCONFIGURED: "Mal configure",
};

/** Une mesure d'exploitation : un libelle discret, une valeur qui se lit d'un coup d'oeil. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium" title={value}>{value}</p>
    </div>
  );
}
