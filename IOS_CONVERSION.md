# Transforming NexusAI into an iOS App

This guide outlines the process of converting the NexusAI Next.js PWA into a native iOS application using **Capacitor**.

## Prerequisites

- **macOS** (Required for iOS builds in Xcode)
- **Xcode** installed
- **CocoaPods** installed (`sudo gem install cocoapods`)
- **Node.js** and **npm**

## 1. Install Capacitor

In your project root, install the Capacitor core and CLI:

```bash
npm install @capacitor/core @capacitor/cli
npx cap init NexusAI com.yourname.nexusai --web-dir out
```

> [!NOTE]
> We use `out` because we will be using a Static Export from Next.js.

## 2. Configure Next.js for Static Export

Modify your `next.config.js` to enable static export:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'export', // Enable static export
    images: {
        unoptimized: true, // Required for static export
    },
};

module.exports = nextConfig;
```

## 3. Add iOS Platform

Install the iOS platform package and add it to the project:

```bash
npm install @capacitor/ios
npx cap add ios
```

## 4. Build and Sync

Whenever you make changes to the web code, follow these steps:

1. **Build the Next.js app**:
    ```bash
    npm run build
    ```
2. **Sync with Capacitor**:
    ```bash
    npx cap copy
    npx cap sync ios
    ```

## 5. Open in Xcode

Open the native iOS project in Xcode to run it on a simulator or physical device:

```bash
npx cap open ios
```

### In Xcode:

1. Select your target device (e.g., iPhone 15).
2. Ensure you have a **Development Team** selected in "Signing & Capabilities".
3. Click the **Play** button to build and run.

## Alternative: iOS Conversion Without a Mac

If you do not have a Mac or access to Xcode, you can still build an iOS app using cloud-based build services.

### Option A: Ionic Appflow (Recommended)

Ionic Appflow is a CI/CD service specifically designed for Capacitor.

1. Sign up at [ionic.io](https://ionic.io/appflow).
2. Connect your GitHub repository.
3. Use their **Cloud Build** feature to generate an `.ipa` file (iOS App Store package) or for **Live Updates**.

### Option B: GitHub Actions / Codemagic

You can use CI tools like **Codemagic** or **GitHub Actions** with macOS runners to build your project. This requires some DevOps knowledge to set up the certificates and profiles.

### Option C: PWA (Easiest)

NexusAI is built as a PWA. On an iPhone:

1. Open the website in **Safari**.
2. Tap the **Share** button.
3. Scroll down and tap **Add to Home Screen**.
   This gives you an app-like experience with an icon on your home screen and no browser UI, without needing a native build.

#### How to test PWA from Localhost?

If you are running the app on your computer (`localhost`), you won't see it on your iPhone Safari by default. Here is how to fix it:

1. **Local Network Access**:
    - Ensure your iPhone and PC are on the **same Wi-Fi**.
    - Find your PC's local IP (Run `ipconfig` on Windows, look for "IPv4 Address", e.g., `192.168.1.50`).
    - On your iPhone Safari, go to `http://192.168.1.50:3000`.
    - _Note: Some PWA features (like installation) require HTTPS._

2. **Use a Tunnel (Best for Installation)**:
    - Use a tool like **ngrok** or **localtunnel** to create a temporary public HTTPS URL.

    ```bash
    npx localtunnel --port 3000
    ```

    - Open the resulting `https://...` URL on your iPhone. Safari will see it as a secure site and allow **Add to Home Screen**.

3. **Production Deployment (Easiest & Free)**:
    - Push your code to **GitHub**.
    - Connect it to **Vercel** (it takes 1 minute).
    - Use the `https://your-app.vercel.app` link on your iPhone. This is the most reliable way to test the full PWA experience.
