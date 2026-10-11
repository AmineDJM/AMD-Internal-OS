"use client";

import * as React from "react";
import Link from "next/link";
import type { EntityType } from "@prisma/client";
import { Loader2, UserPlus, Users } from "lucide-react";
import type { MissionAssignmentDTO, PersonneInvitable } from "@/lib/queries/missions";
import { assignMission, relancerMission, remplacerMission, removeMission, integrerFraisEquipe, choisirBudgetMission } from "@/lib/actions/mission-actions";
import { peutRelancerInvitation, type Etat } from "@/lib/missions-equipe/etat";
import {
  estArbitre, etatParticipation, aQuiLeTour, HEBERGEMENT_LIBELLE, MODE_TRANSPORT_LIBELLE, type FicheParticipation,
} from "@/lib/missions-equipe/participation";
import { lienMission } from "@/lib/chemins/espace";
import { MISSION_ROLE } from "@/lib/labels";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { ChoixPersonne } from "./choix-personne";

type Resultat = { ok: boolean; error?: string; message?: string };

function Pastille({ etat }: { etat: Etat | null }) {
  if (!etat) return <span className="text-muted-foreground">—</span>;
  return <Badge tone={etat.ton} dot={false}>{etat.texte}</Badge>;
}

/** Le transport d'une fiche, en une ligne : « Avion · Oran → Paris ». */
const transportCourt = (f: FicheParticipation) =>
  [MODE_TRANSPORT_LIBELLE[f.transport.mode], f.transport.depart || f.transport.arrivee ? `${f.transport.depart ?? "?"} → ${f.transport.arrivee ?? "?"}` : null].filter(Boolean).join(" · ");

/**
 * « ÉQUIPE ADVENTUM » — les personnes de la société sur une demande Ad & Pro (Direction, 10/2026). Une ligne par
 * personne : où en est sa participation (« état — chez qui »), le transport et l'hébergement sur la table (ou convenus),
 * son ordre de mission, et l'imputation de ses frais (choisie par la Direction Marketing). « Inviter à participer »
 * envoie une demande de participation : la personne répond par sa fiche. Les gestes secondaires (relancer, remplacer,
 * retirer) sont dans « ⋯ ». En bas, à la clôture : les frais de l'équipe, intégrés au budget À LA MAIN.
 */
export function EquipeAdventum({ entityType, entityId, assignments, personnes, canManage, currentUserId, viewerRoles = [], peutBudget = false, budgetOptions = [] }: {
  entityType: EntityType;
  entityId: string;
  assignments: MissionAssignmentDTO[];
  personnes: PersonneInvitable[];
  canManage: boolean;
  currentUserId: string;
  viewerRoles?: string[];
  peutBudget?: boolean;
  budgetOptions?: { id: string; label: string }[];
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [inviter, setInviter] = React.useState(false);
  const [remplacer, setRemplacer] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const occupe = busy !== null || enCours;

  async function executer(cle: string, action: (fd: FormData) => Promise<Resultat>, fd: FormData, apres?: () => void) {
    setBusy(cle); setMsg(null);
    const r = await action(fd);
    setBusy(null);
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "Échec.") });
    if (r.ok) { apres?.(); rafraichir(); }
  }
  const avecId = (id: string, champs: Record<string, string> = {}) => {
    const fd = new FormData(); fd.set("id", id);
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    return fd;
  };

  const dejaLa = assignments.filter((a) => a.response !== "DECLINEE").map((a) => a.userId);
  const confirmes = assignments.filter((a) => a.response === "CONFIRMEE");
  const lignesFrais = confirmes.flatMap((a) => ([
    a.transport && a.transport.statut !== "CANCELLED" ? { a, etape: "TRANSPORT" as const, demande: a.transport, poste: a.transportPosteId } : null,
    a.hebergement && a.hebergement.statut !== "CANCELLED" ? { a, etape: "HEBERGEMENT" as const, demande: a.hebergement, poste: a.hebergementPosteId } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null)));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" /> Équipe Adventum
          <Badge tone="neutral" dot={false}>{assignments.length}</Badge>
          <InfoBulle align="left">
            « Inviter à participer » envoie une demande de participation : la personne répond par sa fiche (dates, transport,
            hébergement) dans Mon espace. Chaque partie accepte, refuse ou contre-propose ; l&apos;accord ouvre l&apos;ordre de
            mission (N+1 puis RH). « Où en est-on » dit toujours qui doit agir.
          </InfoBulle>
        </CardTitle>
        {canManage && (
          <Button size="sm" onClick={() => setInviter((v) => !v)} disabled={occupe}>
            <UserPlus className="h-4 w-4" /> Inviter à participer
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage && inviter && (
          <form
            className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              fd.set("entityType", entityType); fd.set("entityId", entityId);
              void executer("inviter", assignMission, fd, () => setInviter(false));
            }}
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="equipe-personne">Personne</Label>
                <ChoixPersonne id="equipe-personne" name="userId" personnes={personnes} exclus={dejaLa} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="equipe-role">Rôle</Label>
                <Select id="equipe-role" name="role" defaultValue="ACCOMPAGNANT">
                  <option value="ACCOMPAGNANT">Accompagnant</option>
                  <option value="DELEGATE_REFERENCE">Délégué de référence</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="equipe-ville">Ville</Label>
                <Input id="equipe-ville" name="ville" placeholder="Reprise de la demande" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="equipe-depart">Départ</Label>
                <Input id="equipe-depart" name="dateDepart" type="date" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="equipe-retour">Retour</Label>
                <Input id="equipe-retour" name="dateRetour" type="date" />
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setInviter(false)}>Annuler</Button>
              <Button type="submit" size="sm" disabled={occupe}>
                {busy === "inviter" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Envoyer la demande
              </Button>
            </div>
          </form>
        )}

        {assignments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">Personne de l&apos;équipe n&apos;est encore invité à participer.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
                  <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">Personne</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Rôle</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Où en est-on</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Transport</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Hébergement</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Ordre de mission</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1">Imputation
                      <InfoBulle align="right">La Direction Marketing choisit la ligne budgétaire des frais de mission de chacun. Rien n&apos;est imputé sans son choix.</InfoBulle>
                    </span>
                  </th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => {
                  const p = a.participation;
                  const arbitre = estArbitre({ id: currentUserId, roles: viewerRoles }, a.organisateurIds);
                  const vue = a.userId === currentUserId ? "PERSONNE" as const : arbitre ? "ADVENTUM" as const : null;
                  const ouEnEst = etatParticipation(p.etape, p.derniere, vue, { personne: a.userName, organisateur: a.organiserName }, { declineReason: a.declineReason, depuis: a.createdAt });
                  const fiche = p.convenue ?? p.courante;
                  const aMoi = vue !== null && aQuiLeTour(p.etape) === vue;
                  const relance = peutRelancerInvitation({ response: a.response, createdAt: a.createdAt, lastNudgeAt: a.lastNudgeAt, archivedAt: a.archivedAt });
                  const budget = a.budgetCategoryId ? budgetOptions.find((o) => o.id === a.budgetCategoryId)?.label ?? "imputé" : null;
                  return (
                    <React.Fragment key={a.id}>
                      <tr className="border-t border-border align-middle">
                        <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">
                          <Link href={lienMission(a.id)} className="text-primary hover:underline">{a.userName}</Link>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{MISSION_ROLE[a.role]?.label ?? a.role}</td>
                        <td className="whitespace-nowrap px-3 py-2"><Pastille etat={ouEnEst} /></td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {fiche ? transportCourt(fiche) : <Pastille etat={a.transport?.etat ?? null} />}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {fiche ? HEBERGEMENT_LIBELLE[fiche.hebergement.choix] : <Pastille etat={a.hebergement?.etat ?? null} />}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2"><Pastille etat={a.om.etat === "AUCUN" ? null : a.om.libelle} /></td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {peutBudget && a.response !== "DECLINEE" ? (
                            <Select aria-label={`Imputation — ${a.userName}`} className="h-8 min-w-[160px] text-xs" defaultValue={a.budgetCategoryId ?? ""} disabled={occupe}
                              onChange={(e) => void executer(`budget-${a.id}`, choisirBudgetMission, avecId(a.id, { budgetCategoryId: e.target.value }))}>
                              <option value="">— À choisir —</option>
                              {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                            </Select>
                          ) : budget ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                          <Link href={lienMission(a.id)} className={`inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium ${aMoi ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border hover:bg-secondary"}`}>
                            {aMoi ? "Répondre" : p.etape === "ACCORD" || p.etape === "CONFIRMEE_SANS_FICHE" ? "Voir la mission" : "Ouvrir"}
                          </Link>
                          {canManage && (
                            <MenuDossier>
                              {p.etape === "FICHE_A_REMPLIR" && (
                                <Button size="sm" variant="ghost" className="justify-start" disabled={occupe || !relance.ok}
                                  title={relance.ok ? undefined : relance.raison}
                                  onClick={() => void executer(`relance-${a.id}`, relancerMission, avecId(a.id))}>
                                  Relancer{!relance.ok ? " (trop tôt)" : ""}
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" className="justify-start" disabled={occupe} onClick={() => setRemplacer(remplacer === a.id ? null : a.id)}>
                                Remplacer
                              </Button>
                              <Button size="sm" variant="ghost" className="justify-start text-destructive" disabled={occupe}
                                onClick={() => { if (window.confirm(`Retirer ${a.userName} de l'équipe ? La personne est prévenue ; ses pièces et demandes restent archivées.`)) void executer(`retirer-${a.id}`, removeMission, avecId(a.id)); }}>
                                Retirer
                              </Button>
                            </MenuDossier>
                          )}
                          </span>
                        </td>
                      </tr>
                      {remplacer === a.id && (
                        <tr className="border-t border-border bg-secondary/20">
                          <td colSpan={8} className="px-3 py-2">
                            <form className="flex flex-col gap-2 sm:flex-row sm:items-end"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const fd = new FormData(e.currentTarget); fd.set("id", a.id);
                                void executer(`remplacer-${a.id}`, remplacerMission, fd, () => setRemplacer(null));
                              }}>
                              <div className="min-w-0 flex-1 space-y-1">
                                <Label htmlFor={`remplacer-${a.id}`}>Remplacer {a.userName} par</Label>
                                <ChoixPersonne id={`remplacer-${a.id}`} name="userId" personnes={personnes} exclus={dejaLa} />
                              </div>
                              <Button type="submit" size="sm" disabled={occupe}>
                                {busy === `remplacer-${a.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Inviter à sa place
                              </Button>
                            </form>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.texte}</p>}

        {canManage && lignesFrais.length > 0 && <FraisEquipe lignes={lignesFrais} occupe={occupe} executer={executer} />}
      </CardContent>
    </Card>
  );
}

/**
 * « FRAIS DE L'ÉQUIPE ADVENTUM » — à la clôture (Direction : « laisser une case manuelle pour l'intégration au budget
 * exact »). Fermé par défaut ; chaque ligne porte le montant EXACT saisi à la main et la case « Intégrer au budget de la
 * demande ». Rien d'automatique : une ligne non cochée n'est jamais imputée.
 */
function FraisEquipe({ lignes, occupe, executer }: {
  lignes: { a: MissionAssignmentDTO; etape: "TRANSPORT" | "HEBERGEMENT"; demande: { detail: string | null; etat: Etat; href: string | null }; poste: string | null }[];
  occupe: boolean;
  executer: (cle: string, action: (fd: FormData) => Promise<Resultat>, fd: FormData) => Promise<void>;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  return (
    <div className="rounded-lg border border-border">
      <button type="button" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-secondary/40">
        <span>Frais de l&apos;équipe Adventum — à la clôture</span>
        <span className="text-xs text-muted-foreground">{lignes.filter((l) => l.poste).length}/{lignes.length} intégrés</span>
      </button>
      {ouvert && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">Personne</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">Frais</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">Demande</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">Montant exact (DZD)</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">
                  <span className="inline-flex items-center gap-1">Budget
                    <InfoBulle align="right">Cocher crée un poste « Déplacement » ou « Hôtellerie » sur la demande, au montant saisi : il se valide et se range dans un budget comme les autres postes.</InfoBulle>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={`${l.a.id}-${l.etape}`} className="border-t border-border">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2">{l.a.userName}</td>
                  <td className="whitespace-nowrap px-3 py-2">{l.etape === "TRANSPORT" ? "Transport" : "Hébergement"}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {l.demande.href ? <Link href={l.demande.href} className="text-primary hover:underline">{l.demande.detail ?? "Ouvrir"}</Link> : l.demande.detail}
                    <span className="ml-2"><Pastille etat={l.demande.etat} /></span>
                  </td>
                  {l.poste ? (
                    <td colSpan={2} className="whitespace-nowrap px-3 py-2"><Badge tone="success" dot={false}>intégré au budget</Badge></td>
                  ) : (
                    <td colSpan={2} className="px-3 py-2">
                      <form className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const fd = new FormData(e.currentTarget);
                          if (fd.get("integrer") !== "on") return;
                          fd.set("id", l.a.id); fd.set("etape", l.etape);
                          void executer(`frais-${l.a.id}-${l.etape}`, integrerFraisEquipe, fd);
                        }}>
                        <Input name="montant" inputMode="decimal" className="w-32" aria-label="Montant exact (DZD)" required />
                        <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                          <input type="checkbox" name="integrer" required /> Intégrer au budget de la demande
                        </label>
                        <Button type="submit" size="sm" variant="outline" disabled={occupe}>OK</Button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
