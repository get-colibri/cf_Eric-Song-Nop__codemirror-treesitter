import { useEffect, useMemo, useRef, useState } from "react";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { AlertCircleIcon, CloudIcon, RefreshCwIcon, WifiIcon, WifiOffIcon } from "lucide-react";
import { LoroDoc, UndoManager, VersionVector } from "loro-crdt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { GroveMark } from "@/components/GroveMark";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import {
  ShareRelayConnection,
  type ShareRelayConnectionState,
  type ShareRelayStatus,
} from "@/lib/collaboration/share-relay-connection";
import {
  configuredShareRelayOrigin,
  createRelayShareSession,
} from "@/lib/collaboration/share-relay-client";
import { parseShareLink, type ShareLinkParts } from "@/lib/collaboration/share-identity";

type SharedFileRoute =
  | {
      kind: "invalid";
      message: string;
    }
  | {
      kind: "share";
      parts: ShareLinkParts;
    };

type SharedFileEditorProps = {
  href?: string;
};

export function SharedFileEditor({ href = window.location.href }: SharedFileEditorProps) {
  let route = useMemo(() => sharedFileRouteFromHref(href), [href]);
  let relayOrigin = useMemo(() => configuredShareRelayOrigin(), []);
  let [doc] = useState(() => new LoroDoc());
  let [undoManager] = useState(() => new UndoManager(doc, {}));
  let [sessionReady, setSessionReady] = useState(false);
  let [displayName, setDisplayName] = useState("Shared file");
  let [connectionState, setConnectionState] = useState<ShareRelayConnectionState>("connecting");
  let [shareStatus, setShareStatus] = useState<ShareRelayStatus | null>(null);
  let [latestLocalVersion, setLatestLocalVersion] = useState<VersionVector | null>(null);
  let [hostSavedVersion, setHostSavedVersion] = useState<VersionVector | null>(null);
  let [lastHostSavedAt, setLastHostSavedAt] = useState<number | null>(null);
  let [errorMessage, setErrorMessage] = useState("");
  let connectionRef = useRef<ShareRelayConnection | null>(null);
  let extensions = useMemo(
    () => [liveMdLoroCollaboration({ doc, undoManager })],
    [doc, undoManager],
  );

  useEffect(
    () =>
      doc.subscribeLocalUpdates((bytes) => {
        connectionRef.current?.enqueueDocumentUpdate(bytes);
        setLatestLocalVersion(doc.oplogVersion());
      }),
    [doc],
  );

  useEffect(() => {
    if (route.kind == "invalid") {
      setConnectionState("offline");
      setErrorMessage(route.message);
      setSessionReady(false);
      return;
    }

    if (!relayOrigin) {
      setConnectionState("offline");
      setErrorMessage("Shared file relay is not configured.");
      setSessionReady(false);
      return;
    }

    let canceled = false;
    let connection: ShareRelayConnection | null = null;
    setConnectionState("connecting");
    setErrorMessage("");
    setSessionReady(false);
    setLatestLocalVersion(null);
    setHostSavedVersion(null);
    setLastHostSavedAt(null);

    void createRelayShareSession(relayOrigin, route.parts.shareId, "guest", route.parts.guestSecret)
      .then((session) => {
        if (canceled) return;

        setDisplayName(session.displayName);
        setShareStatus({
          displayName: session.displayName,
          expiresAt: session.shareExpiresAt,
          guestCount: session.guestCount,
          hostOnline: session.hostOnline,
          peerCount: session.peerCount,
          pendingHostSave: session.pendingHostSave,
          revokedAt: null,
          shareId: session.shareId,
        });

        connection = new ShareRelayConnection({
          clientId: getOrCreateSharedFileClientId(),
          doc,
          onConnectionState: setConnectionState,
          onError: setErrorMessage,
          onHostSaveAck: (payload) => {
            let ack = parseHostSaveAck(payload);
            if (!ack || ack.shareId != route.parts.shareId) return;
            setLastHostSavedAt(ack.savedAt);
            setHostSavedVersion(ack.versionVector);
          },
          onShareStatus: (status) => {
            setShareStatus(status);
            if (status.displayName) setDisplayName(status.displayName);
          },
          relayOrigin,
          sessionToken: session.sessionToken,
          shareId: route.parts.shareId,
        });
        connectionRef.current = connection;
        connection.connect();
        setSessionReady(true);
      })
      .catch((error: unknown) => {
        if (canceled) return;
        setConnectionState("offline");
        setErrorMessage(errorToMessage(error));
      });

    return () => {
      canceled = true;
      connectionRef.current?.close();
      connectionRef.current = null;
      connection?.close();
    };
  }, [doc, relayOrigin, route]);

  useEffect(() => {
    let handleOnline = () => connectionRef.current?.connect();
    let handleOffline = () => connectionRef.current?.pause();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  let statusLabel = connectionStatusLabel(connectionState);
  let expiresAt = shareStatus?.expiresAt ?? null;
  let saveStatus = guestSaveStatus({
    hostSavedVersion,
    latestLocalVersion,
  });
  let saveStatusTitle =
    saveStatus == "Saved to host" && lastHostSavedAt
      ? `Host saved ${formatTimestamp(lastHostSavedAt)}`
      : undefined;

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GroveMark className="size-7" decorative />
          <div className="min-w-0 truncate text-sm font-medium">{displayName}</div>
        </div>
        <Badge variant="secondary">
          {connectionState == "connected" ? (
            <WifiIcon data-icon="inline-start" />
          ) : connectionState == "connecting" ? (
            <RefreshCwIcon data-icon="inline-start" />
          ) : (
            <WifiOffIcon data-icon="inline-start" />
          )}
          {statusLabel}
        </Badge>
        {shareStatus?.hostOnline ? (
          <Badge variant="secondary">
            <CloudIcon data-icon="inline-start" />
            Host online
          </Badge>
        ) : (
          <Badge variant="outline">Host offline</Badge>
        )}
        {shareStatus && shareStatus.peerCount > 0 && (
          <Badge variant="outline">{shareStatus.peerCount} peers</Badge>
        )}
        {saveStatus && (
          <Badge title={saveStatusTitle} variant="secondary">
            {saveStatus}
          </Badge>
        )}
      </header>

      {errorMessage && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircleIcon className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">{errorMessage}</div>
          {route.kind == "share" && (
            <Button size="sm" variant="outline" onClick={() => connectionRef.current?.connect()}>
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          )}
        </div>
      )}

      {sessionReady ? (
        <section className="min-h-0 flex-1 overflow-hidden">
          <LiveMdEditor
            documentKey={route.kind == "share" ? route.parts.shareId : "shared-file"}
            extensions={extensions}
            initialValue=""
            placeholder="Start writing..."
            onInput={() => {}}
          />
        </section>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <Empty className="max-w-md">
            <EmptyHeader>
              <EmptyMedia>
                <GroveMark className="size-14" />
              </EmptyMedia>
              <EmptyTitle>
                {route.kind == "invalid" ? "Invalid shared file" : "Joining shared file"}
              </EmptyTitle>
            </EmptyHeader>
            {expiresAt && <EmptyContent>Expires {formatTimestamp(expiresAt)}</EmptyContent>}
          </Empty>
        </div>
      )}
    </main>
  );
}

export function isSharedFilePath(pathname: string) {
  return /^\/share(?:\/|$)/.test(pathname);
}

function sharedFileRouteFromHref(href: string): SharedFileRoute {
  let parts = parseShareLink(href);
  if (parts) return { kind: "share", parts };
  return {
    kind: "invalid",
    message: "This shared file link is invalid or missing its edit key.",
  };
}

function connectionStatusLabel(state: ShareRelayConnectionState) {
  if (state == "connected") return "Connected";
  if (state == "connecting") return "Connecting";
  if (state == "resync-required") return "Reconnect required";
  return "Offline";
}

function guestSaveStatus({
  hostSavedVersion,
  latestLocalVersion,
}: {
  hostSavedVersion: VersionVector | null;
  latestLocalVersion: VersionVector | null;
}) {
  if (!latestLocalVersion) return "";
  if (hostSavedVersion && versionCovers(hostSavedVersion, latestLocalVersion)) {
    return "Saved to host";
  }
  return "Waiting for host";
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function parseHostSaveAck(payload: Uint8Array) {
  try {
    let value = JSON.parse(new TextDecoder().decode(payload)) as {
      savedAt?: unknown;
      shareId?: unknown;
      versionVector?: unknown;
    };
    if (typeof value.savedAt != "number" || typeof value.shareId != "string") return null;
    let versionVector = parseVersionVector(value.versionVector);
    if (!versionVector) return null;
    return {
      savedAt: value.savedAt,
      shareId: value.shareId,
      versionVector,
    };
  } catch {
    return null;
  }
}

function parseVersionVector(value: unknown) {
  if (!Array.isArray(value)) return null;
  let version = new Map<`${number}`, number>();
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return null;
    let [peer, counter] = entry;
    if (
      typeof peer != "string" ||
      !/^\d+$/.test(peer) ||
      typeof counter != "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      return null;
    }
    version.set(peer as `${number}`, counter);
  }
  return new VersionVector(version);
}

function versionCovers(saved: VersionVector, local: VersionVector) {
  let comparison = saved.compare(local);
  return comparison == 0 || comparison == 1;
}

function getOrCreateSharedFileClientId() {
  try {
    let existing = sessionStorage.getItem("local-md-workspace:shared-file-client-id");
    if (existing) return existing;
    let next = crypto.randomUUID();
    sessionStorage.setItem("local-md-workspace:shared-file-client-id", next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}
