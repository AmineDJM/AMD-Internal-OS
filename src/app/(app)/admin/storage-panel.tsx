"use client";

import * as React from "react";
import { Loader2, PlugZap, Check, X, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SelfTestReport } from "@/lib/storage/self-test";
import { sansBloquer } from "@/lib/journal";

/**
 * STOCKAGE OBJET — état et test de connexion (Super Admin).
 *
 * « Les variables sont renseignées » ne prouve rien : un bucket mal nommé, une clé périmée ou une
 * région fausse donnent la même page verte. Le bouton écrit donc réellement un petit objet dans le
 * bucket, le relit, compare son contenu, et le supprime — c'est le seul test qui répond à
 * « est-ce que ça marche ? ».
 *
 * Rien de sensible ne transite : le rapport ne contient que l'hôte, le bucket et la région.
 */
export function StoragePanel({ initial }: { initial: SelfTestReport["config"] }) {
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<SelfTestReport | null>(null);
  const cfg = report?.config ?? initial;

  // ENVOI DIRECT DEPUIS CE NAVIGATEUR — le vrai chemin des gros fichiers : une partie poussée par le
  // navigateur (règle CORS : PUT autorisé), puis recollée par le serveur à partir des empreintes que
  // le BUCKET liste. L'ETag lu par le navigateur n'est qu'un secours (Supabase ne l'expose pas).
  const [cors, setCors] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [corsBusy, setCorsBusy] = React.useState(false);
  const testerCors = async () => {
    setCorsBusy(true); setCors(null);
    try {
      const r = await fetch("/api/admin/storage/cors-test", { method: "POST" });
      const b = (await r.json()) as { url?: string; key?: string; uploadId?: string; error?: string };
      if (!r.ok || !b.url || !b.key || !b.uploadId) { setCors({ ok: false, texte: b.error ?? "Signature refusée." }); return; }
      const corps = new Blob(["test d'envoi direct en plusieurs parties"]);
      let res: Response;
      try {
        res = await fetch(b.url, { method: "PUT", body: corps });
      } catch {
        void fetch("/api/admin/storage/cors-test", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: b.key, uploadId: b.uploadId, total: corps.size }) });
        setCors({ ok: false, texte: "Le navigateur n'a pas pu écrire dans le bucket : la règle CORS manque (AllowedOrigins = l'adresse de l'application, AllowedMethods = PUT). Voir docs/stockage-gros-fichiers.md." });
        return;
      }
      const etag = res.headers.get("ETag");
      const fin = await fetch("/api/admin/storage/cors-test", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: b.key, uploadId: b.uploadId, total: corps.size, etag: etag ?? undefined }),
      });
      const f = (await fin.json().catch(sansBloquer("storage-panel.testerCors.json", {}))) as { ok?: boolean; empreintes?: string; error?: string };
      if (!res.ok) setCors({ ok: false, texte: `Le bucket a refusé l'envoi (code ${res.status}).` });
      else if (f.ok && f.empreintes === "bucket") {
        setCors({ ok: true, texte: `Envoi direct depuis ce navigateur : OK — partie envoyée par le navigateur et recollée par le serveur à partir des empreintes du stockage.${etag ? "" : " L'en-tête ETag n'est pas exposé au navigateur : sans effet, il n'est pas nécessaire."} Les gros fichiers partiront directement au bucket.` });
      } else if (f.ok) {
        setCors({ ok: true, texte: "Envoi direct depuis ce navigateur : OK — recollé grâce à l'ETag lu par le navigateur (le stockage ne liste pas les parties). Gardez « ExposeHeaders: ETag » dans la règle CORS." });
      } else {
        setCors({ ok: false, texte: `Envoi accepté, mais le recollage a échoué : ${f.error ?? "erreur inconnue"}${etag ? "" : " — le stockage ne liste pas les parties et l'ETag n'est pas exposé au navigateur : ajoutez « ExposeHeaders: ETag » à la règle CORS."}` });
      }
    } finally { setCorsBusy(false); }
  };

  const run = () => {
    setBusy(true);
    void fetch("/api/admin/storage/self-test", { method: "POST" })
      .then((r) => r.json() as Promise<SelfTestReport>)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        {cfg.disabled ? (
          // On nomme le drapeau EXACT : envoyer chercher « S3_DISABLED » quand c'est l'ancien
          // « REG_S3_DISABLED » qui traîne fait chercher une variable qui n'existe pas.
          <Badge tone="warning" dot={false}>Désactivé ({cfg.disabledBy ?? "S3_DISABLED"})</Badge>
        ) : cfg.configured ? (
          <Badge tone="success" dot={false}>{cfg.provider}</Badge>
        ) : (
          <Badge tone="neutral" dot={false}>Non configuré — stockage en base</Badge>
        )}
        {cfg.configured && (
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {cfg.endpointHost}{cfg.endpointPath} · bucket <strong className="text-foreground">{cfg.bucket}</strong> · région {cfg.region}
            {cfg.pathStyle ? " · chemin" : " · sous-domaine"}
            {cfg.variableSource === "REG_S3" && " · variables REG_S3_* (anciennes)"}
          </span>
        )}
        {!cfg.configured && !cfg.disabled && cfg.missing.length > 0 && (
          <span className="text-xs text-muted-foreground">Manque : {cfg.missing.join(", ")}</span>
        )}
        {cfg.mixedSources && (
          // Techniquement complet, très probablement faux : une clé n'est valable que sur l'hôte
          // qui l'a émise, et l'erreur qui en résulte (« SignatureDoesNotMatch ») n'oriente vers rien.
          <span className="text-xs font-medium text-destructive">
            Variables mélangées :{" "}
            {Object.entries(cfg.sources).filter(([, s]) => s === "REG_S3").map(([n]) => n.replace(/^S3_/, "REG_S3_")).join(", ")}
            {" "}vient de l&apos;ancienne famille — complétez les S3_*.
          </span>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={run} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Tester la connexion
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Le test écrit un objet dans un préfixe dédié (<code>_selftest/</code>), le relit, compare son
        contenu et le supprime. Les fichiers déjà stockés en base restent lisibles quoi qu&apos;il
        arrive — le stockage objet ne concerne que les nouveaux enregistrements.
      </p>

      {cfg.configured ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void testerCors()} disabled={corsBusy}>
            {corsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Tester l&apos;envoi direct (navigateur)
          </Button>
          {cors && (
            <span className={cors.ok ? "text-xs text-success" : "text-xs text-destructive"} aria-live="polite">{cors.texte}</span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Sans stockage objet, les gros fichiers (dossiers CTD de plusieurs Go) sont <strong>refusés</strong> — ils
          rempliraient la base. Pour les accepter : créer un bucket (Cloudflare R2 ou AWS S3), puis poser
          <code> S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY_ID</code>, <code>S3_SECRET_ACCESS_KEY</code> et
          <code> S3_REGION</code> dans Render → Environment. Guide pas à pas : <code>docs/stockage-gros-fichiers.md</code>.
        </p>
      )}

      {report && (
        <ul className="surface divide-y divide-border text-sm">
          {report.steps.map((s) => (
            <li key={s.step} className="flex flex-wrap items-center gap-3 px-3 py-2">
              {s.ok
                ? <Check className="h-4 w-4 shrink-0 text-success" />
                : <X className="h-4 w-4 shrink-0 text-destructive" />}
              <span className="font-medium">{s.label}</span>
              <span className="text-xs text-muted-foreground">{s.ms} ms</span>
              {s.detail && <span className="min-w-0 flex-1 text-xs text-muted-foreground">{s.detail}</span>}
            </li>
          ))}
          <li className="px-3 py-2 text-xs text-muted-foreground">
            {report.ok
              ? "Le stockage objet répond : écriture, lecture, vérification et suppression ont abouti."
              : "Le stockage objet n'est pas utilisable en l'état — l'application continue d'écrire en base."}
            {report.cleaned ? " L'objet de test a été supprimé." : ""}
          </li>
        </ul>
      )}
    </div>
  );
}
