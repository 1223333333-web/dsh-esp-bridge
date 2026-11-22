// dsh-esp-bridge example: send a line from Serial to DSH and print the reply.
// Replace WIFI_SSID, WIFI_PASS, and DSH_URL before flashing.
//
// DSH_URL must point at the DSH web server or a reverse proxy that exposes
// the /esp/* routes. If DSH only listens on 127.0.0.1, expose port 8124
// (dsh-phone-remote bridge) or use a LAN reverse proxy first.

#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* DSH_URL   = "http://192.168.1.100:8124/esp/ask";
// Leave empty if authToken is not configured on the PC side.
const char* DSH_TOKEN = "";

String escapeJson(String s) {
  s.replace("\\", "\\\\");
  s.replace("\"", "\\\"");
  s.replace("\n", "\\n");
  s.replace("\r", "");
  return s;
}

void askDSH(const String& text) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] not connected");
    return;
  }

  HTTPClient http;
  http.begin(DSH_URL);
  http.addHeader("Content-Type", "application/json");
  if (strlen(DSH_TOKEN) > 0) {
    http.addHeader("Authorization", String("Bearer ") + DSH_TOKEN);
  }
  http.setTimeout(200000);  // DSH may take a while; longer than waitMs

  String body = "{\"text\":\"" + escapeJson(text) + "\"}";
  int code = http.POST(body);

  Serial.printf("[HTTP] %d\n", code);
  String reply = http.getString();
  Serial.println(reply);

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());
  Serial.println("Type a message and press Enter.");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length()) {
      askDSH(line);
    }
  }
  delay(20);
}
