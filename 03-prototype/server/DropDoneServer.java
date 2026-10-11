import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Drop & Done prototype server (Java 8, zero dependencies).
 *
 *  - Serves the static app and the deck from the Lab folder.
 *  - POST /api/claude        forwards a Messages API request to Claude, adding the API key server-side.
 *  - GET  /api/config        tells the UI whether live AI is available.
 *  - GET/POST /api/claims    mock corporate reimbursement system (in-memory).
 *  - POST /api/claims/{id}/decision   approver / finance actions, checked against TRANSITIONS.
 *
 * Binds to 127.0.0.1 only. The server stores the claim as submitted; it does not re-run the policy engine.
 */
public class DropDoneServer {

    private static final String ANTHROPIC_URL = System.getenv().getOrDefault("ANTHROPIC_URL", "https://api.anthropic.com/v1/messages");
    private static final String FALLBACK_BETA = "server-side-fallback-2026-07-01";

    private static Path root;
    private static String apiKey;
    private static final Map<String, StoredClaim> CLAIMS = new LinkedHashMap<>();
    private static final AtomicInteger SEQ = new AtomicInteger(1040);

    private static class StoredClaim {
        String id, status, submittedAt, json;
    }

    // Claim lifecycle on the server. DRAFT and READY exist only in the browser; anything not listed is a 409.
    private static final Map<String, List<String>> TRANSITIONS = new HashMap<>();
    static {
        TRANSITIONS.put("SUBMITTED", Arrays.asList("APPROVED", "REJECTED"));
        TRANSITIONS.put("APPROVED", Arrays.asList("PAID", "REJECTED"));
        TRANSITIONS.put("REJECTED", Collections.<String>emptyList());
        TRANSITIONS.put("PAID", Collections.<String>emptyList());
    }

    static boolean canMove(String from, String to) {
        List<String> next = TRANSITIONS.get(from);
        return next != null && next.contains(to);
    }

    public static void main(String[] args) throws IOException {
        root = Paths.get(args.length > 0 ? args[0] : ".").toAbsolutePath().normalize();
        apiKey = System.getenv("ANTHROPIC_API_KEY");
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8787"));

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newFixedThreadPool(16));
        server.createContext("/api/config", DropDoneServer::config);
        server.createContext("/api/claude", DropDoneServer::claude);
        server.createContext("/api/claims", DropDoneServer::claims);
        server.createContext("/", DropDoneServer::staticFiles);
        server.start();

        System.out.println("Drop & Done running at http://localhost:" + port + "/");
        System.out.println("  App   : http://localhost:" + port + "/03-prototype/app/");
        System.out.println("  Deck  : http://localhost:" + port + "/02-pitch-deck/pitch-deck.html");
        System.out.println("  Live AI: " + (hasKey() ? "ENABLED (ANTHROPIC_API_KEY found)" : "DISABLED - demo mode (set ANTHROPIC_API_KEY to enable)"));
    }

    private static boolean hasKey() {
        return apiKey != null && !apiKey.trim().isEmpty();
    }

    // ---------------------------------------------------------------- API

    private static void config(HttpExchange ex) throws IOException {
        send(ex, 200, "application/json", "{\"aiEnabled\":" + hasKey() + "}");
    }

    private static void claude(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) { send(ex, 405, "text/plain", "POST only"); return; }
        if (!hasKey()) { send(ex, 503, "application/json", "{\"error\":{\"type\":\"no_api_key\",\"message\":\"ANTHROPIC_API_KEY is not set on the server\"}}"); return; }

        byte[] body = readAll(ex.getRequestBody());
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ANTHROPIC_URL).openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(20_000);
            c.setReadTimeout(300_000);
            c.setRequestProperty("content-type", "application/json");
            c.setRequestProperty("x-api-key", apiKey.trim());
            c.setRequestProperty("anthropic-version", "2023-06-01");
            c.setRequestProperty("anthropic-beta", FALLBACK_BETA);
            try (OutputStream os = c.getOutputStream()) { os.write(body); }

            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] resp = in == null ? new byte[0] : readAll(in);
            send(ex, code, "application/json", resp);
        } catch (IOException e) {
            String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
            System.err.println("[claude proxy] " + msg);
            send(ex, 502, "application/json", "{\"error\":{\"type\":\"upstream_unreachable\",\"message\":" + jsonString(msg) + "}}");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void claims(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod();

        // POST /api/claims/{id}/decision
        if (path.matches("/api/claims/[A-Z0-9-]+/decision") && "POST".equals(method)) {
            String id = path.split("/")[3];
            String body = new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8);
            String status = null;
            try {
                Object d = Json.parse(body);
                Object v = d instanceof Map ? ((Map<?, ?>) d).get("decision") : null;
                if ("APPROVED".equals(v) || "REJECTED".equals(v) || "PAID".equals(v)) status = (String) v;
            } catch (IllegalArgumentException ignored) {
                // falls through to the 400 below
            }
            synchronized (CLAIMS) {
                StoredClaim sc = CLAIMS.get(id);
                if (sc == null) { send(ex, 404, "application/json", "{\"error\":\"not_found\"}"); return; }
                if (status == null) { send(ex, 400, "application/json", "{\"error\":" + jsonString("body must be {\"decision\": \"APPROVED\" | \"REJECTED\" | \"PAID\"}") + "}"); return; }
                if (!canMove(sc.status, status)) {
                    send(ex, 409, "application/json", "{\"error\":" + jsonString("cannot move a " + sc.status + " claim to " + status) + ",\"status\":" + jsonString(sc.status) + "}");
                    return;
                }
                sc.status = status;
                send(ex, 200, "application/json", toJson(sc));
            }
            return;
        }

        if ("/api/claims".equals(path) && "GET".equals(method)) {
            StringBuilder sb = new StringBuilder("[");
            synchronized (CLAIMS) {
                boolean first = true;
                for (StoredClaim sc : CLAIMS.values()) {
                    if (!first) sb.append(',');
                    sb.append(toJson(sc));
                    first = false;
                }
            }
            send(ex, 200, "application/json", sb.append(']').toString());
            return;
        }

        if ("/api/claims".equals(path) && "POST".equals(method)) {
            String body = new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8).trim();
            String problem = validateClaim(body);
            if (problem != null) { send(ex, 400, "application/json", "{\"error\":" + jsonString(problem) + "}"); return; }
            StoredClaim sc = new StoredClaim();
            sc.id = "RCL-2026-" + String.format("%06d", SEQ.incrementAndGet());
            sc.status = "SUBMITTED";
            sc.submittedAt = Instant.now().toString();
            sc.json = body;
            synchronized (CLAIMS) { CLAIMS.put(sc.id, sc); }
            System.out.println("[mock finance] claim " + sc.id + " received");
            send(ex, 201, "application/json", toJson(sc));
            return;
        }

        send(ex, 404, "application/json", "{\"error\":\"not_found\"}");
    }

    /**
     * Checks that a submitted claim is well-formed JSON with the parts the approver inbox reads
     * (employee, totals.claimable, trips[].lines[]). Returns a reason, or null if it is acceptable.
     * Stored claims are echoed verbatim into GET /api/claims, so one malformed body would break the list.
     */
    static String validateClaim(String body) {
        Object root;
        try { root = Json.parse(body); } catch (IllegalArgumentException e) { return "claim is not valid JSON: " + e.getMessage(); }
        if (!(root instanceof Map)) return "claim must be a JSON object";
        Map<?, ?> claim = (Map<?, ?>) root;
        if (!(claim.get("employee") instanceof Map)) return "claim.employee must be an object";
        Object totals = claim.get("totals");
        if (!(totals instanceof Map) || !(((Map<?, ?>) totals).get("claimable") instanceof Double)) return "claim.totals.claimable must be a number";
        Object trips = claim.get("trips");
        if (!(trips instanceof List)) return "claim.trips must be an array";
        for (Object t : (List<?>) trips) {
            if (!(t instanceof Map) || !(((Map<?, ?>) t).get("lines") instanceof List)) return "every trip must be an object with a lines array";
        }
        return null;
    }

    private static String toJson(StoredClaim sc) {
        return "{\"id\":" + jsonString(sc.id) + ",\"status\":" + jsonString(sc.status)
                + ",\"submittedAt\":" + jsonString(sc.submittedAt) + ",\"claim\":" + sc.json + "}";
    }

    // ---------------------------------------------------------------- static

    private static void staticFiles(HttpExchange ex) throws IOException {
        String p = java.net.URLDecoder.decode(ex.getRequestURI().getPath(), "UTF-8");
        if ("/".equals(p)) {
            ex.getResponseHeaders().add("Location", "/03-prototype/app/");
            send(ex, 302, "text/plain", "");
            return;
        }
        Path file = root.resolve(p.substring(1)).normalize();
        if (!file.startsWith(root)) { send(ex, 403, "text/plain", "forbidden"); return; }
        if (Files.isDirectory(file)) file = file.resolve("index.html");
        if (!Files.isRegularFile(file)) { send(ex, 404, "text/plain", "not found"); return; }
        ex.getResponseHeaders().add("Cache-Control", "no-store");
        send(ex, 200, contentType(file.toString()), Files.readAllBytes(file));
    }

    private static String contentType(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    // ---------------------------------------------------------------- utils

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int r;
        while ((r = in.read(buf)) != -1) bos.write(buf, 0, r);
        return bos.toByteArray();
    }

    private static void send(HttpExchange ex, int code, String type, String body) throws IOException {
        send(ex, code, type, body.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(HttpExchange ex, int code, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(code, body.length == 0 ? -1 : body.length);
        if (body.length > 0) try (OutputStream os = ex.getResponseBody()) { os.write(body); }
        ex.close();
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch)); else sb.append(ch);
            }
        }
        return sb.append('"').toString();
    }

    /**
     * Minimal strict JSON parser (RFC 8259), enough to validate request bodies without a dependency.
     * Objects become Map, arrays List, numbers Double, plus String, Boolean and null.
     */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) { this.s = s; }

        static Object parse(String text) {
            if (text == null) throw new IllegalArgumentException("empty body");
            Json p = new Json(text);
            p.ws();
            Object v = p.value(0);
            p.ws();
            if (p.i != p.s.length()) throw p.err("unexpected trailing characters");
            return v;
        }

        private IllegalArgumentException err(String msg) { return new IllegalArgumentException(msg + " at position " + i); }

        private void ws() { while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++; }

        private char peek() { if (i >= s.length()) throw err("unexpected end"); return s.charAt(i); }

        private void expect(char c) { if (peek() != c) throw err("expected '" + c + "'"); i++; }

        private Object value(int depth) {
            if (depth > 64) throw err("nested too deeply");
            char c = peek();
            if (c == '{') return object(depth);
            if (c == '[') return array(depth);
            if (c == '"') return string();
            if (c == '-' || (c >= '0' && c <= '9')) return number();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            throw err("unexpected character '" + c + "'");
        }

        private Map<String, Object> object(int depth) {
            Map<String, Object> m = new LinkedHashMap<>();
            expect('{'); ws();
            if (peek() == '}') { i++; return m; }
            while (true) {
                ws();
                if (peek() != '"') throw err("expected a string key");
                String k = string();
                ws(); expect(':'); ws();
                m.put(k, value(depth + 1));
                ws();
                if (peek() == ',') { i++; continue; }
                expect('}');
                return m;
            }
        }

        private List<Object> array(int depth) {
            List<Object> a = new ArrayList<>();
            expect('['); ws();
            if (peek() == ']') { i++; return a; }
            while (true) {
                ws();
                a.add(value(depth + 1));
                ws();
                if (peek() == ',') { i++; continue; }
                expect(']');
                return a;
            }
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = peek(); i++;
                if (c == '"') return sb.toString();
                if (c < 0x20) throw err("control character in string");
                if (c != '\\') { sb.append(c); continue; }
                char e = peek(); i++;
                switch (e) {
                    case '"': case '\\': case '/': sb.append(e); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw err("bad unicode escape");
                        try { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); } catch (NumberFormatException x) { throw err("bad unicode escape"); }
                        i += 4;
                        break;
                    default: throw err("bad escape");
                }
            }
        }

        private Double number() {
            int start = i;
            if (s.charAt(i) == '-') i++;
            if (i < s.length() && s.charAt(i) == '0') i++;
            else if (!digits()) throw err("bad number");
            if (i < s.length() && s.charAt(i) == '.') { i++; if (!digits()) throw err("bad number"); }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                if (!digits()) throw err("bad number");
            }
            return Double.valueOf(s.substring(start, i));
        }

        private boolean digits() {
            int start = i;
            while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
            return i > start;
        }
    }
}
