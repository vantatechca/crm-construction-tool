// client/src/hooks/useWebSocket.ts
import { useState, useEffect, useRef } from "react";

export function useWebSocket(isAuthenticated: boolean = true) {
  const [data, setData] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;

  useEffect(() => {
    // ✅ Only connect if authenticated
    if (!isAuthenticated) {
      console.log("⏸️ WebSocket disabled - not authenticated");

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      setIsConnected(false);
      return;
    }

    // Determine WebSocket URL based on environment
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      import.meta.env.VITE_WS_URL ||
      `${protocol}//${window.location.host}/ws`;
    console.log(`🔌 WebSocket URL:`, wsUrl);

    const connect = () => {
      // Prevent connection if already connecting/connected
      if (
        wsRef.current?.readyState === WebSocket.CONNECTING ||
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        console.log("⏸️ WebSocket already connected or connecting");
        return;
      }

      console.log(
        `🔌 Attempting WebSocket connection #${reconnectAttempts.current + 1}:`,
        wsUrl
      );

      try {
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        // ✅ Connection timeout
        const connectionTimeout = setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            console.log("⏱️ WebSocket connection timeout");
            socket.close();
          }
        }, 10000); // 10 second timeout

        socket.onopen = () => {
          clearTimeout(connectionTimeout);
          console.log("✅ WebSocket connected successfully");
          setIsConnected(true);
          reconnectAttempts.current = 0; // Reset on successful connection
        };

        socket.onmessage = (event) => {
          try {
            const parsedData = JSON.parse(event.data);

            // Ignore connection_established messages (just for logging)
            if (parsedData.type === "connection_established") {
              console.log("🔗 WebSocket connection confirmed by server");
              return;
            }

            console.log("📨 WebSocket message:", parsedData.type);
            setData(parsedData);
          } catch (error) {
            console.error("❌ Error parsing WebSocket message:", error);
          }
        };

        socket.onclose = (event) => {
          clearTimeout(connectionTimeout);
          console.log(
            `🔌 WebSocket disconnected (Code: ${event.code}, Reason: ${
              event.reason || "Unknown"
            })`
          );
          setIsConnected(false);
          wsRef.current = null;

          // Only reconnect if still authenticated and haven't exceeded max attempts
          if (
            isAuthenticated &&
            reconnectAttempts.current < maxReconnectAttempts
          ) {
            reconnectAttempts.current++;
            const delay = Math.min(
              1000 * Math.pow(2, reconnectAttempts.current - 1),
              30000
            ); // Exponential backoff, max 30s
            console.log(
              `🔄 Reconnecting in ${delay}ms (Attempt ${reconnectAttempts.current}/${maxReconnectAttempts})...`
            );
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          } else if (reconnectAttempts.current >= maxReconnectAttempts) {
            console.error(
              "❌ Max WebSocket reconnection attempts reached. Please refresh the page."
            );
          }
        };

        socket.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.error("❌ WebSocket error:", error);
          setIsConnected(false);
        };
      } catch (error) {
        console.error("❌ Failed to create WebSocket:", error);
        setIsConnected(false);

        // Retry connection
        if (reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++;
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttempts.current - 1),
            30000
          );
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      }
    };

    connect();

    return () => {
      console.log("🧹 Cleaning up WebSocket");

      // Clear timeout first
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }

      // Close socket if exists
      if (wsRef.current) {
        // Remove event listeners before closing to prevent state updates
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;

        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }

      // Reset state
      setIsConnected(false);
    };
  }, [isAuthenticated]);

  return { data, isConnected };
}
