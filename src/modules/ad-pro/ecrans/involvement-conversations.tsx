"use client";

import * as React from "react";
import Link from "next/link";
import { MessagesSquare, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DossierMessageItem, DossierMessageForm } from "@/app/(app)/dossiers/[id]/panel";
import type { InvolvementThread } from "@/lib/queries/involvement";

/**
 * LES ÉCHANGES AVEC LES PERSONNES IMPLIQUÉES — remontés SOUS la demande.
 *
 * Quand on sollicite une tierce personne, la conversation se tenait dans un projet à part que
 * le demandeur oubliait d'ouvrir. Elle apparaît maintenant en bas de la demande : une
 * conversation par personne (« les deux parties »), avec messages et pièces jointes des deux
 * côtés — exactement le fil des dossiers, réutilisé tel quel, jamais recopié.
 *
 * La personne impliquée, elle, retrouve la MÊME conversation depuis son espace (le projet) :
 * ce sont les deux faces d'un seul fil. C'est ce qui permet à quelqu'un sans accès au module de
 * répondre quand même.
 */
export function InvolvementConversations({
  threads, currentUserId, canManage,
}: {
  threads: InvolvementThread[];
  currentUserId: string;
  /** La Direction / l'admin peut modérer n'importe quel message. */
  canManage: boolean;
}) {
  if (threads.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4" /> Échanges avec les personnes impliquées
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 sm:space-y-5">
        {threads.map((t) => {
          // Seul un membre du fil écrit. Le demandeur (créateur) et la personne l'étant tous deux,
          // ce test couvre les deux côtés sans droit de module.
          const iAmMember = t.members.some((m) => m.id === currentUserId);
          const memberName = new Map(t.members.map((m) => [m.id, m.name]));
          return (
            <section key={t.dossierId} className="space-y-3 rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">Avec {t.personName}</h3>
                <Link href={`/dossiers/${t.dossierId}`} className="inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
                  Ouvrir le sujet <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {t.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun échange pour l&apos;instant.</p>
              ) : (
                <ul className="space-y-3">
                  {t.messages.map((m) => {
                    const mine = m.authorId === currentUserId;
                    return (
                      <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <DossierMessageItem
                          id={m.id}
                          body={m.body}
                          author={m.author}
                          createdAt={m.createdAt}
                          mine={mine}
                          canManage={mine || canManage}
                          attachments={m.attachments}
                          mentionNames={m.mentionIds.map((uid) => memberName.get(uid)).filter((n): n is string => Boolean(n))}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}

              {iAmMember && <DossierMessageForm id={t.dossierId} members={t.members} />}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
