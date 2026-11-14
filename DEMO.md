# 3-minute demo script

**Setup before you walk up:** `/api/demo/reset`, open five tabs in order, phone
on speaker with the number pre-dialed, laptop on hotspot tethering.

| Time | Beat | Say | On screen |
| --- | --- | --- | --- |
| 0:00 | The problem | "Miami HVAC shops lose half their calls. The owner is on a roof, the caller speaks Spanish, and nobody picks up." | Landing page |
| 0:15 | Setup | "Ask me for any AC company in Miami." *(judge names one)* "I paste their site." | `/onboarding`, paste URL, Enter |
| 0:35 | It reads | "She's reading their services, hours, and area — and writing her own call script. No forms." | Extraction checklist animating |
| 0:55 | Review | "Six services, real prices, service area. I can fix anything here." | Review card |
| 1:05 | Live | "Go live." *(number appears)* "That's a real number. Call it." | "She is answering" + number |
| 1:20 | The call | *Hand the judge the phone, or call it yourself in Spanglish:* "Hi, mira, my AC is broken and hace mucho calor." | Live call |
| 1:45 | Triage | *Agent:* "No problem — ¿está goteando agua? Is it leaking?" *You:* "No leak, but my mom is 78." | — |
| 2:00 | Books | *Agent:* "I have tomorrow at 2 PM." *You:* "Perfect." | — |
| 2:10 | The proof | "Hang up. Watch." | SMS arrives on your phone: confirmation + price |
| 2:25 | Emergency | Switch to Demo console → **Emergency · English** → **Call her** | Deposit link renders, $189 |
| 2:40 | The day | "Now the part nobody builds — she calls *him*." Hit **Generate now** on Briefings, play it. | Spanglish voice note |
| 2:55 | Close | "One URL, two minutes, and the phone stops ringing out. That's Recepcionista." | Dashboard |

## Fallback plan

| If | Then |
| --- | --- |
| ElevenLabs latency spikes | Skip the live call. Run **Demo console → Español · Rutina**. Same endpoints, same artifacts, 3 seconds. |
| Twilio SMS doesn't land | The SMS body is rendered in the demo console panel. Show that. |
| Wi-Fi dies | Everything is local. Briefing audio is pre-generated on disk; the phone call is the only network dependency. |
| Judge's URL scrapes poorly | The review screen says "thin website — safe template." That is a *feature*: say so, then continue. Never debug live. |
| Stripe link 500s | Mock `/pay/[id]` page is local and always works. |

## What to say if asked "is this real?"

Yes — the booking writes to the database, the SMS goes through Twilio, the
deposit link is a real Stripe test-mode link, and the voice note is real TTS.
The only mocked piece is the calendar, which is ours by design (no OAuth in a
5-hour build).
