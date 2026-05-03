# Child Location Monitoring System (CLMS)

## Overview
The Child Location Monitoring System (CLMS) is a robust, real-time web application designed to track and ensure the safety of children. It integrates WebSockets, IoT protocols (MQTT), and modern web technologies to provide parents with live location tracking, geofence configuration, and immediate alerts for SOS signals or boundary violations.

The system is strictly role-based, differentiating between Administrative users, Parents, and IoT Devices (Children). Children act solely as data-emitting endpoints and do not require system user accounts.

Beyond its core tracking capabilities, CLMS is engineered as a highly dependable system. It incorporates advanced fault tolerance, multi-level redundancy, strict safety validations, and robust reliability mechanisms to ensure that critical tracking data and emergency alerts are never lost, even in the event of database outages or network instability.

## Core Features
*   **Real-Time Tracking:** Live GPS coordinates are plotted onto interactive maps using Leaflet.js, updated instantly via Socket.io.
*   **Geofencing:** Parents can define safety zones (a fixed 1 km radius or a custom bounding rectangle).
*   **Automated Alerts:** The system continuously evaluates coordinates against defined geofences and emits alerts upon entry or exit.
*   **Emergency SOS:** IoT devices can trigger instant SOS alerts, overriding standard workflows to notify parents immediately.
*   **Historical Data:** GPS trajectories are logged and accessible for review up to the latest 100 entries per device.
*   **Secure Access:** Role-based access control, secure session management, and bcrypt password hashing.
*   **Data Isolation:** Socket.io emits are scoped strictly to private rooms, ensuring parents only receive data related to their linked devices.

## Dependability Features
*   **Persistent Queue (MongoDB-based):** A durable, database-backed queue guarantees at-least-once processing for all incoming MQTT messages and alert retry events.
*   **Retry Mechanism with Backoff:** All database writes and network operations are wrapped in an exponential backoff retry utility to handle transient failures.
*   **Multi-Channel Alert Delivery:** Alerts are delivered via primary WebSockets, with automatic fallback to a secondary channel (simulated email/logs) and tertiary queue re-entry if the parent is offline.
*   **Database Redundancy:** Simulated database replication employs a three-layer write-through system (Primary MongoDB collection → Secondary backup collection → Tertiary file-based fallback).
*   **Failover Behavior:** In the event of primary database read failures, the system gracefully falls back to reading from the secondary backup collection.
*   **State Persistence:** Geofence states and last-seen timestamps are strictly persisted to the database. The system relies on zero in-memory critical state, allowing it to survive unexpected server restarts.
*   **Heartbeat Monitoring:** A background worker continuously tracks device activity and automatically issues an "OFFLINE" alert if a device fails to report its location for more than 5 minutes.

## Fault Tolerance and Redundancy
CLMS is designed to eliminate single points of failure at the application level. If the primary database goes offline, the system utilizes an in-memory buffer to queue incoming MQTT traffic, migrating it to the persistent queue upon reconnection. Alert delivery is guaranteed through multi-channel redundancy; if a WebSocket alert cannot be confirmed, the system retries delivery up to 3 times via alternative channels. 

*Note: The current redundancy implementation is an application-level simulation intended to demonstrate dependable systems design. It mimics the behavior of a real distributed cluster and replica set within a localized environment.*

## Security Enhancements
*   **Password Security:** All user passwords are encrypted using `bcrypt` (12 salt rounds) prior to storage.
*   **Device Authentication:** IoT endpoints utilize a secure, pre-shared `deviceSecret` validated via bcrypt hashing to prevent unauthorized access to the SOS API.
*   **Data Validation:** Strict geographic schema validation rejects NaN inputs, out-of-bounds coordinates, and logically impossible geofence parameters.
*   **Rate Limiting:** Protects critical endpoints like `/login` and `/iot/sos` against brute-force attacks and alert spamming.
*   **Session Security:** Session cookies are hardened using `httpOnly` and `sameSite` attributes, with production configurations enforcing `secure` (HTTPS-only) transmission.

## System Reliability Behavior
*   **When the Database Fails:** The server remains active. Incoming MQTT messages are temporarily buffered in memory. Once the database recovers, buffered messages are flushed to the persistent queue and processed chronologically, ensuring zero data loss.
*   **When MQTT Fails:** The application dashboard remains fully functional, allowing parents to review historical data and configure geofences while the MQTT client automatically attempts to reconnect in the background.
*   **Alert Preservation:** If a database write fails during an alert generation, the system prioritizes safety over persistence, emitting the live WebSocket alert immediately and relying on the fallback notifier to retry database logging.
*   **Queue Recovery:** The background worker continuously polls the persistent queue, guaranteeing that no alert or location ping is permanently lost due to transient processing errors.

## Limitations
*   The system currently runs as a single Node.js instance and does not represent a truly distributed computing cluster.
*   Database redundancy is simulated using secondary collections and local file fallbacks rather than a full MongoDB Replica Set distributed across multiple physical servers.
*   The fallback alert channel currently writes to a simulated email log (`logs/simulated_email.log`); integration with a real SMTP provider (e.g., SendGrid, Nodemailer) is required for production.

## Technology Stack
*   **Backend:** Node.js, Express.js
*   **Database:** MongoDB, Mongoose ORM
*   **Real-Time Communication:** Socket.io (WebSockets)
*   **Message Broker:** MQTT (HiveMQ Cloud)
*   **Security:** express-session, bcrypt
*   **Frontend Mapping:** Leaflet.js, OpenStreetMap

## Prerequisites
Before you begin, ensure you have the following installed and running:
1.  **Node.js** (v18.0.0 or higher)
2.  **MongoDB Community Server** (Running locally on the default port `27017`)
3.  **An MQTT Tracker App** (e.g., OwnTracks) configured on a mobile device to act as the IoT node.

## Installation

1.  **Clone the Repository**
    Navigate to your desired directory and clone the repository.

2.  **Install Dependencies**
    Execute the following command in the project root to install all required Node.js packages:
    ```bash
    npm install
    ```

3.  **Start MongoDB**
    Ensure your local MongoDB instance is active and accessible at `mongodb://127.0.0.1:27017/clms_database`.

## Initializing the Database (Seeding Admin)

To manage users and assign parent-child links, you must first create an Administrator account. Execute the following script once from the project root:

```bash
node -e "
require('./db.js');
const bcrypt = require('bcrypt');
const User = require('./models/User');
async function seed() {
    const hash = await bcrypt.hash('admin123', 12);
    await User.create({ username: 'admin', name: 'Administrator', role: 'admin', passwordHash: hash });
    console.log('Admin account created successfully.'); 
    process.exit();
}
seed();
"
```

*   **Default Admin Username:** `admin`
*   **Default Admin Password:** `admin123`

## Running the Application

To start the server, run:
```bash
node server.js
```
The server will initialize and listen on `http://localhost:3000`.

## How to Use

### 1. Administrative Workflow
*   Navigate to `http://localhost:3000/login` and log in using the Admin credentials (`admin` / `admin123`).
*   From the Admin Dashboard, you can monitor the total user base, delete accounts, and explicitly create new Parent accounts if needed.

### 2. Parent Workflow
*   **Registration:** Parents can self-register at `http://localhost:3000/register`.
*   **Linking a Device:** Log into the Parent dashboard and enter the target **Device ID**. This ID must match the final segment of the MQTT topic configured on the child's tracker.
*   **Configuring Geofences:** Select the linked device and click "Configure Geofence". Choose either a **Radius** (fixed 1 km around a center point) or a **Rectangle** (bounding box).
*   **Monitoring:** The "Live Map" tab will automatically update when the IoT device transmits data. Alerts will appear in the "Alerts" tab.

### 3. IoT Device Configuration (OwnTracks)
To simulate or track a child, configure an MQTT app like OwnTracks with the following parameters:

*   **Mode:** MQTT
*   **Host:** `eea6ea368a3b45f59f40963f1e2dcf47.s1.eu.hivemq.cloud`
*   **Port:** `8883`
*   **UserID:** `liu_apple`
*   **Password:** `@@Dominhhien1305`
*   **DeviceID:** (e.g., `leo_test_child` - This acts as the Child ID linked in the web dashboard)
*   **Base Topic (pubTopicBase):** `clmshk252group3/clms`

The final topic where the device publishes its location should resolve to:
`clmshk252group3/clms/<DeviceID>`

### Simulating an SOS Alert
To trigger an emergency alert from the device programmatically, send an HTTP POST request to the server:

*   **Endpoint:** `POST http://localhost:3000/iot/sos`
*   **Headers:** `Content-Type: application/json`
*   **Payload:**
    ```json
    {
      "childId": "<DeviceID>",
      "deviceSecret": "your-configured-secret"
    }
    ```

## Project Architecture

```
CLMS-HK252/
├── server.js                  # Application entry point
├── db.js                      # MongoDB connection handler
├── package.json               # Dependencies and scripts
├── models/
│   ├── User.js                # Mongoose schema for Parents and Admins
│   ├── History.js             # Mongoose schema for GPS logs
│   └── Notification.js        # Mongoose schema for Alerts
├── services/
│   ├── geofence.js            # Mathematical bounds evaluation & dual-algorithm verification
│   ├── mqttService.js         # Message ingestion, queueing, and event dispatch
│   ├── dbService.js           # Multi-layer simulated database replication
│   ├── queueService.js        # Persistent MongoDB-backed event queue
│   ├── worker.js              # Background queue processing and retries
│   ├── fallbackNotifier.js    # Multi-channel alert delivery (WebSocket + Fallback)
│   └── heartbeat.js           # Active device monitoring and offline detection
├── utils/
│   ├── logger.js              # Structured multi-instance logging utility
│   ├── retry.js               # Exponential backoff and timeout wrapper
│   └── validate.js            # Strict coordinate and geofence validation helper
├── middleware/
│   └── auth.js                # Session and Role-based access guards
├── routes/
│   ├── auth.js                # Authentication endpoints with rate limiting
│   ├── admin.js               # Administrative endpoints
│   ├── parent.js              # Parent endpoints (devices, geofence, history)
│   ├── iot.js                 # Hardware endpoints (SOS with device authentication)
│   └── dashboard.js           # Server-side HTML dashboard rendering
└── views/
    ├── login.html             # Login view template
    └── register.html          # Registration view template
```
