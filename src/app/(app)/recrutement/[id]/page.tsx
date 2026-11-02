import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip, CheckCircle2, XCircle, CircleDashed, MinusCircle, Megaphone } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BackLink } from "@/components/shared/back-link";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { recruitmentViewer } from "@/lib/recruitment/access";
import {
  abilities, chainProgress, currentStep, CONTRACT_LABEL, CANDIDATE_LABEL, CANDIDATE_TONE,
  STAGE_LABEL, STAGE_TONE, salaryRange, needsOnboarding, candidateRank, canDecideStep, reouverture,
  decisionDuSommetExigeSuivi, friseDuRecrutement, statutDuRecrutement,
  type ChainStep, type RecruitmentStage, type RecruitmentContract, type CandidateStatus,
} from "@/lib/recruitment/request-flow";
import { emploiticConfigure } from "@/lib/recruitment/diffusion";
import { etatAffiche, publicationsDe, suspensionEnVigueur } from "@/lib/site-web/etat";
import { posteOuvert } from "@/lib/site-web/contenus";
import { peutPublierOffres } from "@/lib/site-web/acces";
import {
  ChainDecisionPanel, CancelRequestButton, HrPanel, AnswerInfoForm,
  AddCandidateButton, CandidateActions, OnboardPanel, CloseRequestButton,
  CorrigerDemandePanel, RouvrirPanel, FilForm,
} from "./panels";
import { DiffusionCard, type EtatCanalAffiche } from "./diffusion";

export const dynamic = "force-dynamic";

/** Les natures de pièce qu'on joint à une demande de recrutement. */
const DOC_CATEGORIES = ["REQUEST_LETTER", "SUPPORTING_DOC", "OTHER"];

const APPROVAL_ICON = {
  APPROVED: <CheckCircle2 className="h-4 w-4 text-success" />,
  REJECTED: <XCircle className="h-4 w-4 text-destructive" />,
  PENDING: <CircleDashed className="h-4 w-4 text-warning" />,
  SKIPPED: <MinusCircle className="h-4 w-4 text-muted-foreground" />,
} as const;

const APPROVAL_TEXT = {
  APPROVED: "a validé",
  REJECTED: "a refusé",
  PENDING: "n'a pas encore tranché",
  // Ne PAS écrire « a validé » : la direction a tranché par-dessus, ce maillon n'a rien vu.
  SKIPPED: "n'a pas été consulté (décision prise plus haut)",
} as const;

const TON_STATUT = {
  info: "border-primary/30 bg-primary/10 text-primary",
  succes: "border-success/30 bg-success/10 text-success",
  attente: "border-warning/40 bg-warning/10 text-warning",
  refus: "border-destructive/30 bg-destructive/5 text-destructive",
  neutre: "border-border bg-secondary/40 text-foreground",
} as const;

/** « Yacine Habes » → « Y. Habes » : la frise n'a la place que d'un nom court. */
function nomCourt(nom: string): string {
  const p = nom.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]![0]}. ${p.slice(1).join(" ")}` : nom;
}

/**
 * LE DOSSIER D'UN RECRUTEMENT — le besoin, son parcours, sa diffusion, et les candidats.
 *
 * Un seul écran pour tout le circuit (Direction, 07/10 : module à part sous les RH) : n'importe qui y suit sa
 * demande, chaque validateur y voit ce qu'ont dit les précédents, le DG y désigne le N+1 de la future recrue et le
 * suivi, les RH y instruisent et DIFFUSENT l'offre (site, LinkedIn, Emploitic, autre), et les candidats y avancent.
 *
 * Règles d'écran de la Direction : la frise et la phrase « état — chez qui » en tête, UN geste principal visible
 * (le panneau de la personne qu'on attend), le reste dans « ⋯ », l'explication dans les ⓘ. Ce qui s'AFFICHE est
 * calculé ici, une fois, par le même `abilities()` que le serveur revérifie ensuite.
 */
export default async function RecruitmentPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("RECRUITMENT");
  const viewer = await recruitmentViewer(user, params.id);
  if (!viewer) notFound();

  const req = await prisma.recruitmentRequest.findUnique({
    where: { id: params.id },
    include: {
      requester: { select: { name: true } },
      department: { select: { name: true, head: { select: { userId: true } } } },
      company: { select: { name: true, shortName: true } },
      futureManager: { select: { name: true } },
      followers: { orderBy: { createdAt: "asc" }, select: { userId: true, user: { select: { name: true } } } },
      channelPosts: true,
      approvals: {
        orderBy: { order: "asc" },
        include: { approver: { select: { name: true } } },
      },
      infoRequests: {
        orderBy: { createdAt: "asc" },
        include: { askedBy: { select: { name: true } }, answeredBy: { select: { name: true } } },
      },
      candidates: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!req) notFound();

  const stage = req.stage as RecruitmentStage;
  const contract = req.contractType as RecruitmentContract;
  const steps: ChainStep[] = req.approvals.map((a) => ({
    order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "—", status: a.status,
  }));
  const untouched = steps.every((s) => s.status === "PENDING");
  const hired = req.candidates.find((c) => c.status === "HIRED");
  const decideur = { userId: user.id, isTop: viewer.isTop };
  // Les MÊMES faits que les actions (§118.192) : qui peut trancher la marche, un recrutement prononcé, une
  // embauche encore sans fiche — un bouton visible est un geste que l'action acceptera.
  const can = abilities(stage, viewer, {
    chainUntouched: untouched, hasHire: Boolean(hired),
    peutTrancherLaMarche: canDecideStep(stage, steps, decideur).ok,
    aRecrute: Boolean(hired),
    embaucheSansFiche: Boolean(hired) && hired?.employeeId == null,
  });
  const ouRouvrir = can.reopen ? reouverture(stage, steps, Boolean(hired)) : null;
  const destinationReouverture = ouRouvrir && !("refus" in ouRouvrir)
    ? ouRouvrir.vers === "CHAIN"
      ? `Elle repartira à la marche qui l'a refusée (${steps.find((s) => s.order === ouRouvrir.marche)?.approverName ?? "—"}), et à elle seule.`
      : ouRouvrir.vers === "HR_REVIEW" ? "Elle reviendra aux RH, qui l'avaient refusée." : "Le poste sera de nouveau ouvert."
    : null;
  const active = currentStep(steps);
  const progress = chainProgress(steps);
  const myTurn = stage === "CHAIN" && (active?.approverId === user.id || viewer.isTop);
  // LE DG QUI CONCLUT DÉSIGNE LE N+1 ET LE SUIVI (Direction, 07/10) — la règle que l'action rejoue.
  const exigeSuivi = myTurn && decisionDuSommetExigeSuivi(stage, steps, decideur);

  const [renvoyePar, fil, utilisateurs] = await Promise.all([
    req.returnedById ? prisma.user.findUnique({ where: { id: req.returnedById }, select: { name: true } }) : Promise.resolve(null),
    // L'HISTOIRE DE LA DEMANDE (§118.192) : refus, renvois, corrections, réouvertures, messages.
    prisma.comment.findMany({
      where: { entityType: "RECRUITMENT_REQUEST", entityId: req.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, body: true, createdAt: true, author: { select: { name: true } } },
    }),
    exigeSuivi
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  // Le N+1 proposé : le chef du département demandé, à défaut le demandeur.
  const n1ParDefaut = exigeSuivi ? (req.department?.head?.userId ?? req.requesterId) : null;

  // LA DIFFUSION (§118.158, Direction 07/10) — l'offre du site telle que le SITE l'a confirmée, et les autres canaux.
  const publieOffres = peutPublierOffres(user);
  const offreSite = publieOffres
    ? await prisma.jobPosting.findUnique({ where: { recruitmentRequestId: req.id }, select: { id: true, published: true } })
    : null;
  const etatOffre = offreSite
    ? etatAffiche((await publicationsDe("JOB", [offreSite.id])).get(offreSite.id) ?? null, offreSite.published, await suspensionEnVigueur())
    : null;
  const canal = (c: string): EtatCanalAffiche => {
    const p = req.channelPosts.find((x) => x.channel === c);
    return { statut: p?.status ?? null, contenu: p?.content ?? null, url: p?.url ?? null, erreur: p?.error ?? null, publieLe: p?.publishedAt?.toISOString() ?? null };
  };
  const montrerDiffusion = publieOffres && (can.diffuse || Boolean(offreSite) || req.channelPosts.length > 0);

  const [documents, cvs] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "RECRUITMENT_REQUEST", entityId: req.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.document.findMany({
      where: { entityType: "RECRUITMENT_CANDIDATE", entityId: { in: req.candidates.map((c) => c.id) } },
      select: { id: true, name: true, entityId: true, fileKey: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const cvByCandidate = new Map<string, { id: string; name: string }[]>();
  for (const d of cvs) {
    cvByCandidate.set(d.entityId, [...(cvByCandidate.get(d.entityId) ?? []), { id: d.id, name: d.name }]);
  }

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  const canUpload = userCan(user, "RECRUITMENT", "UPLOAD") && !["CLOSED", "REJECTED", "CANCELLED"].includes(stage);
  const salary = salaryRange(
    req.salaryMin != null ? Number(req.salaryMin) : null,
    req.salaryMax != null ? Number(req.salaryMax) : null,
  );
  // L'ordre du pipeline, pas l'ordre d'arrivée : on regarde d'abord ceux qui avancent.
  const candidates = [...req.candidates].sort(
    (a, b) => candidateRank(b.status as CandidateStatus) - candidateRank(a.status as CandidateStatus)
      || a.fullName.localeCompare(b.fullName),
  );

  // LA FRISE ET LA PHRASE « ÉTAT — CHEZ QUI ».
  const frise = friseDuRecrutement(stage, steps.map((s) => ({ ...s, approverName: nomCourt(s.approverName ?? "—") })), {
    returnedFrom: req.returnedFrom as RecruitmentStage | null,
  });
  const aVous = myTurn
    || ((stage === "RETURNED" || stage === "INFO_REQUESTED") && viewer.isRequester)
    || (stage === "HR_REVIEW" && (can.openSourcing || can.askInfo));
  const statut = statutDuRecrutement(stage, { waitingOn: active?.approverName ?? null, requesterName: req.requester?.name ?? null, aVous });
  const suivi = req.followers.map((f) => f.user?.name ?? "—");

  // « ⋯ » — les gestes secondaires : retirer, clôturer sans suite, rouvrir.
  const peutClore = (viewer.isHr || viewer.isTop) && (stage === "SOURCING" || stage === "ONBOARDING");
  const gestesSecondaires = can.cancel || peutClore || Boolean(can.reopen && destinationReouverture);

  return (
    <div className="space-y-5">
      <BackLink href="/recrutement">
        <ArrowLeft className="h-4 w-4" /> Retour au recrutement
      </BackLink>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STAGE_TONE[stage]} dot={false}>{STAGE_LABEL[stage]}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{req.reference}</span>
            {req.company && (
              <span className="text-xs text-muted-foreground">{req.company.shortName || req.company.name}</span>
            )}
          </div>
          <h1 className="mt-1 break-words text-xl font-semibold sm:text-2xl">{req.position}</h1>
          <p className="text-sm text-muted-foreground">
            Demandé par {req.requester?.name ?? "—"} le {formatDate(req.createdAt)}
            {req.department ? ` · ${req.department.name}` : ""}
          </p>
        </div>
        {gestesSecondaires && (
          <MenuDossier>
            {can.cancel && <CancelRequestButton id={req.id} />}
            {peutClore && <CloseRequestButton id={req.id} />}
            {can.reopen && destinationReouverture && <RouvrirPanel id={req.id} destination={destinationReouverture} />}
          </MenuDossier>
        )}
      </div>

      {/* LA DEMANDE — la frise, la phrase « état — chez qui », le N+1 et le suivi désignés par le DG. */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <ol aria-label="Étapes de la demande" className="grid auto-cols-[minmax(6.5rem,1fr)] grid-flow-col gap-1.5 overflow-x-auto pb-1">
            {frise.map((e) => (
              <li
                key={e.cle}
                title={[e.titre, e.detail].filter(Boolean).join(" — ")}
                className={cn(
                  "min-w-0 border-t-[3px] pt-1.5 text-xs",
                  e.etat === "done" ? "border-success text-success"
                    : e.etat === "current" ? "border-primary text-primary"
                      : e.etat === "rejected" ? "border-destructive text-destructive"
                        : "border-border text-muted-foreground",
                )}
              >
                <p className={cn("truncate", e.etat === "current" ? "font-semibold" : "font-medium")}>
                  {e.etat === "done" ? "✓ " : e.etat === "current" ? "⏱ " : e.etat === "rejected" ? "✗ " : ""}{e.titre}
                </p>
                <p className="truncate text-[0.6875rem] opacity-90">{e.detail || " "}</p>
              </li>
            ))}
          </ol>
          <div className={cn("rounded-lg border px-3 py-2.5 sm:px-4", TON_STATUT[statut.ton])}>
            <p className="font-semibold [overflow-wrap:anywhere]">{statut.phrase}</p>
            {stage === "RETURNED" && req.returnNote && (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs font-normal text-foreground">
                « {req.returnNote} »{renvoyePar ? ` — ${renvoyePar.name}` : ""}{req.returnedAt ? `, le ${formatDate(req.returnedAt)}` : ""}
              </p>
            )}
          </div>
          {(req.futureManager || suivi.length > 0) && (
            <p className="text-sm">
              <span className="text-muted-foreground">N+1 :</span> <span className="font-medium">{req.futureManager?.name ?? "—"}</span>
              <span className="text-muted-foreground"> · Suivi :</span> <span className="font-medium">{suivi.join(", ") || "—"}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {can.correct && (
        <CorrigerDemandePanel
          id={req.id}
          besoin={{
            position: req.position, headcount: req.headcount, contractType: req.contractType,
            salaryMin: req.salaryMin != null ? Number(req.salaryMin) : null,
            salaryMax: req.salaryMax != null ? Number(req.salaryMax) : null,
            startDate: req.startDate ? req.startDate.toISOString().slice(0, 10) : null,
            endDate: req.endDate ? req.endDate.toISOString().slice(0, 10) : null,
            missions: req.missions, skills: req.skills, justification: req.justification,
          }}
        />
      )}

      {myTurn && active && (
        <ChainDecisionPanel
          id={req.id}
          stepLabel={
            active.approverId === user.id
              ? `Marche ${active.order} sur ${progress.total}.`
              : `Marche ${active.order} sur ${progress.total} — normalement ${active.approverName}.`
          }
          exigeSuivi={exigeSuivi}
          utilisateurs={utilisateurs}
          n1ParDefaut={n1ParDefaut}
        />
      )}

      {(can.askInfo || can.openSourcing || can.hrReject || (can.returnForCorrection && stage === "HR_REVIEW")) && (
        <HrPanel
          id={req.id} canAsk={can.askInfo} canOpen={can.openSourcing} canReject={can.hrReject}
          canReturn={can.returnForCorrection && stage === "HR_REVIEW"}
        />
      )}

      {can.onboard && hired && (
        <OnboardPanel id={req.id} hiredName={hired.fullName} external={!needsOnboarding(contract)} canCancelHire={can.cancelHire} />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {montrerDiffusion && (
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="flex items-center gap-2"><Megaphone className="h-4 w-4" /> Diffusion</CardTitle>
                <InfoBulle label="Comment se diffuse une offre">
                  Choisissez le ou les canaux. Le site publie l&apos;offre préparée (visible tant que le poste est ouvert).
                  LinkedIn : Luna prépare un post selon l&apos;entité, vous le publiez vous-même puis le marquez publié.
                  Emploitic s&apos;ouvrira quand son API sera configurée.
                </InfoBulle>
              </CardHeader>
              <CardContent>
                {offreSite?.published && !posteOuvert(stage) && (
                  <p className="mb-2 text-xs text-warning">Poste non ouvert : l&apos;offre reste invisible sur le site.</p>
                )}
                <DiffusionCard
                  id={req.id}
                  peutAgir={can.diffuse}
                  site={{
                    offreId: offreSite?.id ?? null, publiee: offreSite?.published ?? false,
                    libelle: etatOffre?.libelle ?? null, ton: etatOffre?.ton ?? "neutral", lien: etatOffre?.lien ?? null,
                  }}
                  linkedin={canal("LINKEDIN")}
                  emploitic={{ ...canal("EMPLOITIC"), configure: emploiticConfigure(process.env) }}
                  autre={canal("AUTRE")}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Le besoin</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <Info label="Type de contrat" value={CONTRACT_LABEL[contract] ?? req.contractType} />
              <Info label="Nombre de postes" value={String(req.headcount)} />
              <Info label="Rémunération" value={salary} />
              <Info label="Prise de poste" value={req.startDate ? formatDate(req.startDate) : null} />
              <Info label="Fin de contrat" value={req.endDate ? formatDate(req.endDate) : null} />
              <Info label="Direction" value={req.department?.name} />
              {req.missions && <Block label="Missions" value={req.missions} />}
              {req.skills && <Block label="Compétences attendues" value={req.skills} />}
              {req.justification && <Block label="Pourquoi ce recrutement" value={req.justification} />}
              {req.closingNote && <Block label="Décision" value={req.closingNote} />}
            </CardContent>
          </Card>

          {/* LES PRÉCISIONS — le va-et-vient RH ↔ demandeur, question par question. */}
          {(req.infoRequests.length > 0 || can.answerInfo) && (
            <Card>
              <CardHeader><CardTitle>Précisions demandées par les RH</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {req.infoRequests.length === 0 && (
                  <p className="text-muted-foreground">Aucune précision demandée.</p>
                )}
                {req.infoRequests.map((q) => (
                  <div key={q.id} className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      {q.askedBy?.name ?? "RH"} · {formatDateTime(q.createdAt)}
                    </p>
                    <p className="mt-0.5 font-medium">{q.question}</p>
                    {q.answer ? (
                      <p className="mt-2 border-l-2 border-success/50 pl-2 text-muted-foreground">
                        <span className="text-foreground">{q.answer}</span>
                        <span className="block text-xs">
                          {q.answeredBy?.name ?? "—"} · {q.answeredAt ? formatDateTime(q.answeredAt) : ""}
                        </span>
                      </p>
                    ) : can.answerInfo ? (
                      <AnswerInfoForm id={req.id} infoId={q.id} />
                    ) : (
                      <p className="mt-1 text-xs text-warning">En attente de la réponse du demandeur.</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* LES CV REÇUS — le pipeline vit sur les PERSONNES. */}
          {(stage === "SOURCING" || stage === "ONBOARDING" || candidates.length > 0) && (
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle>CV reçus <span className="text-sm font-normal text-muted-foreground">({candidates.length})</span></CardTitle>
                {can.addCandidate && <AddCandidateButton requestId={req.id} />}
              </CardHeader>
              <CardContent className="space-y-2">
                {candidates.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Aucun CV déposé.</p>
                ) : candidates.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 break-words font-medium">{c.fullName}</p>
                        <Badge tone={CANDIDATE_TONE[c.status as CandidateStatus]} dot={false}>
                          {CANDIDATE_LABEL[c.status as CandidateStatus]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {[c.email, c.phone, c.source].filter(Boolean).join(" · ") || "—"}
                      </p>
                      {c.notes && <p className="mt-1 break-words text-xs text-muted-foreground">{c.notes}</p>}
                      {c.interviewAt && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Entretien le {formatDate(c.interviewAt)}{c.interviewNote ? ` — ${c.interviewNote}` : ""}
                        </p>
                      )}
                      {(cvByCandidate.get(c.id) ?? []).map((d) => (
                        <a
                          key={d.id} href={`/api/documents/${d.id}`}
                          className="mt-1 mr-3 inline-flex max-w-full items-center gap-1 py-1 text-xs text-primary [overflow-wrap:anywhere] hover:underline"
                        >
                          <Paperclip className="h-3 w-3 shrink-0" /> {d.name}
                        </a>
                      ))}
                    </div>
                    <CandidateActions
                      candidateId={c.id}
                      status={c.status}
                      can={{ shortlist: can.shortlist, select: can.select, interview: can.interview, hire: can.hire }}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {(fil.length > 0 || can.comment) && (
            <Card>
              <CardHeader><CardTitle>Fil de la demande</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {fil.map((c) => (
                  <div key={c.id} className="rounded-lg border border-border p-2.5">
                    <p className="text-xs text-muted-foreground">{c.author?.name ?? "—"} · {formatDateTime(c.createdAt)}</p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
                  </div>
                ))}
                {can.comment && <FilForm id={req.id} />}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Fiche de poste et pièces
                <span className="text-sm font-normal text-muted-foreground">({documents.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {canUpload && (
                <DocumentUpload entityType="RECRUITMENT_REQUEST" entityId={req.id} categories={DOC_CATEGORIES} />
              )}
              <DocumentList
                documents={docItems} canDelete={viewer.isHr || viewer.isTop}
                canEdit={viewer.isHr || viewer.isTop} canRename={viewer.isHr || viewer.isTop}
                path={`/recrutement/${req.id}`}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>
                Validation hiérarchique{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  {progress.done} / {progress.total}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              {req.approvals.map((a) => (
                <div key={a.id} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">{APPROVAL_ICON[a.status]}</span>
                  <div className="min-w-0">
                    <p className="font-medium">{a.approver?.name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {APPROVAL_TEXT[a.status]}
                      {a.decidedAt ? ` · ${formatDate(a.decidedAt)}` : ""}
                    </p>
                    {a.reason && <p className="text-xs text-muted-foreground">« {a.reason} »</p>}
                  </div>
                </div>
              ))}
              {req.approvals.length === 0 && (
                <p className="text-muted-foreground">Aucun validateur — l&apos;organigramme est incomplet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words font-medium">{value || "—"}</p>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-span-2 sm:col-span-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap break-words">{value}</p>
    </div>
  );
}
