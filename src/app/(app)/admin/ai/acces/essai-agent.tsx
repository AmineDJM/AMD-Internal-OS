"use client";

import * as React from "react";
import { FlaskConical, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { essayerAgentDeLaPersonne } from "@/modules/assistant-ia/actions-consommation";
import { echangeDe, ESSAI_MESSAGE_MAX, type EchangeEssai, type IssueEssai, type TourEssai } from "@/modules/assistant-ia/partage";
import { ChatMessageList } from "@/modules/assistant-ia/ecrans/chat-message-list";
import { versMessage, type TourDuFil } from "@/modules/assistant-ia/ecrans/use-fil";
import { actionFailureMessage } from "@/lib/action-outcome";
import type { LignePersonne } from "./acces-form";

/**
 * ESSAYER L'AGENT D'UNE PERSONNE (Super Admin, Direction 03/11/2026) — avant de l'ouvrir en production. Le message est
 * joué par son VRAI tour, sous son identité, ses droits et la garde de ses données (`infra/essai/service.ts`) ; la
 * réponse est dessinée par l'écran même de l'assistant (`ChatMessageList`). Rien n'est enregistré chez elle, rien ne
 * sort ; une carte proposée se lit, elle ne s'exécute pas.
 */
type Fait = Extract<IssueEssai, { ok: true }>;

const PAS_D_EXECUTION = { ok: false, error: "Essai : la carte montre ce que l'agent proposerait à la personne — rien ne s'exécute ici." } as const;

export function EssaiAgent({ personnes }: { personnes: LignePersonne[] }) {
  const [id, setId] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [tours, setTours] = React.useState<TourEssai[]>([]);
  const [echanges, setEchanges] = React.useState<EchangeEssai[]>([]);
  const [dernier, setDernier] = React.useState<Fait | null>(null);
  const [envoi, setEnvoi] = React.useState<string | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const personne = personnes.find((p) => p.id === id) ?? null;

  const recommencer = () => { setTours([]); setEchanges([]); setDernier(null); setErreur(null); };

  const essayer = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const texte = message.trim();
    if (!id || !texte || envoi) return;
    setEnvoi(texte);
    setErreur(null);
    try {
      const fd = new FormData();
      fd.set("personneId", id);
      fd.set("message", texte);
      fd.set("precedents", JSON.stringify(echanges));
      const r = await essayerAgentDeLaPersonne(fd);
      if (!r.ok) { setErreur(r.erreur); return; }
      setDernier(r);
      if (r.refus) { setErreur(`Ce que la personne verrait : ${r.refus}`); return; }
      setTours(r.tours);
      const e = echangeDe(texte, r.tours);
      if (e) setEchanges((x) => [...x, e]);
      setMessage("");
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(null);
    }
  };

  const messages = [
    ...tours.map((t) => versMessage(t as unknown as TourDuFil)),
    ...(envoi ? [{ id: "essai-envoi", role: "user" as const, content: envoi }] : []),
  ];

  return (
    <Card data-testid="essai-agent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-4 w-4" /> Essayer son agent</CardTitle>
        <p className="text-sm text-muted-foreground">
          Le message part par le <strong>vrai</strong> chemin de son assistant — son identité, ses droits, ses familles et périmètres, sa
          mémoire, ses réglages, la garde de ses données : ce que l&apos;agent peut lire ici est exactement ce qu&apos;il lira pour elle.
          <strong> Rien n&apos;est enregistré chez la personne</strong> (conversation, cartes, mémoire, consommation : annulés) et
          <strong> rien ne sort</strong> (courriel, notification, appel externe : neutralisés) ; seul le modèle est appelé. Le modèle
          peut formuler deux réponses différemment, comme pour deux envois de la personne. Chaque essai est inscrit à l&apos;audit.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Personne dont on essaie l'agent" value={id} disabled={!!envoi}
            onChange={(e) => { setId(e.target.value); recommencer(); }}
            className="h-9 w-full max-w-md rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Choisir une personne…</option>
            {personnes.map((p) => <option key={p.id} value={p.id}>{p.nom} — {p.role}</option>)}
          </select>
          {tours.length > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={recommencer} disabled={!!envoi}>
              <RotateCcw className="mr-1 h-4 w-4" /> Nouvel essai
            </Button>
          )}
        </div>

        {personne && (
          <>
            {messages.length > 0 && (
              <div className="max-h-[32rem] overflow-y-auto rounded-xl border bg-muted/30" data-testid="essai-fil">
                <ChatMessageList messages={messages} isLoading={!!envoi} onConfirmIntent={async () => PAS_D_EXECUTION} />
              </div>
            )}
            {envoi && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> L&apos;agent de {personne.nom} répond — jusqu&apos;à quelques minutes pour une demande longue.
              </p>
            )}
            {erreur && <p role="alert" className="text-sm text-destructive">{erreur}</p>}
            {dernier && !dernier.refus && (
              <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2" data-testid="essai-bilan">
                <div className="rounded-md bg-muted/60 p-3">
                  <p className="font-medium">Ce que ce tour aurait écrit — annulé</p>
                  {dernier.ecritures.length ? (
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">{dernier.ecritures.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  ) : <p className="mt-1 text-muted-foreground">Rien d&apos;autre que la conversation.</p>}
                </div>
                <div className="rounded-md bg-muted/60 p-3">
                  <p className="font-medium">Ce qui serait sorti — neutralisé</p>
                  {dernier.sorties.length ? (
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">{dernier.sorties.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  ) : <p className="mt-1 text-muted-foreground">Rien.</p>}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {dernier.consommation.appels} appel(s) de modèle · {dernier.consommation.jetonsEntree + dernier.consommation.jetonsSortie} jetons ·{" "}
                    {dernier.consommation.coutUsd.toFixed(4)} $ · {Math.round(dernier.dureeMs / 1000)} s — imputés à l&apos;audit, pas à la personne.
                  </p>
                </div>
              </div>
            )}
            <form onSubmit={essayer} className="space-y-2">
              <textarea
                aria-label={`Message à essayer comme ${personne.nom}`} value={message} maxLength={ESSAI_MESSAGE_MAX} rows={3} disabled={!!envoi}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={`Ce que ${personne.nom} écrirait à son assistant…`}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
              <Button type="submit" size="sm" disabled={!message.trim() || !!envoi}>
                {envoi ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-1 h-4 w-4" />} Essayer comme {personne.nom}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
