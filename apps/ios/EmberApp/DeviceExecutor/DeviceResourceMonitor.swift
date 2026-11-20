import Darwin
import Foundation
import UIKit

/// Point-in-time hardware, memory, CPU, and thermal snapshot for an Apple device process.
public struct DeviceResourceSnapshot: Equatable, Sendable {
    public let monotonicNanoseconds: UInt64
    public let cpuUserMicros: UInt64
    public let cpuSystemMicros: UInt64
    public let physFootprintBytes: UInt64
    public let thermalState: DeviceThermalLevel
    public let isLowPowerModeEnabled: Bool
    public let batteryLevel: Float?
    public let deviceModelIdentifier: String
    public let osVersion: String
}

/// Captures safe, App Store-compliant process resource metrics using Darwin/Mach & ProcessInfo APIs.
public enum DeviceResourceMonitor {
    public static func capture(includeBattery: Bool = false) async -> DeviceResourceSnapshot {
        let now = DispatchTime.now().uptimeNanoseconds
        let (userMicros, sysMicros) = readCPUMicroseconds()
        let footprint = readPhysicalFootprintBytes()
        let processInfo = ProcessInfo.processInfo
        let thermal = DeviceThermalLevel(processInfo.thermalState)
        let lowPower = processInfo.isLowPowerModeEnabled
        let osVersion = processInfo.operatingSystemVersionString
        let model = readMachineIdentifier()

        let battery: Float?
        if includeBattery {
            battery = await MainActor.run {
                let device = UIDevice.current
                let wasEnabled = device.isBatteryMonitoringEnabled
                if !wasEnabled {
                    device.isBatteryMonitoringEnabled = true
                }
                let level = device.batteryLevel
                if !wasEnabled {
                    device.isBatteryMonitoringEnabled = false
                }
                return level >= 0 ? level : nil
            }
        } else {
            battery = nil
        }

        return DeviceResourceSnapshot(
            monotonicNanoseconds: now,
            cpuUserMicros: userMicros,
            cpuSystemMicros: sysMicros,
            physFootprintBytes: footprint,
            thermalState: thermal,
            isLowPowerModeEnabled: lowPower,
            batteryLevel: battery,
            deviceModelIdentifier: model,
            osVersion: osVersion
        )
    }

    public static func metrics(
        from start: DeviceResourceSnapshot,
        to end: DeviceResourceSnapshot,
        stepsCompleted: Int,
        artifactsGenerated: Int
    ) -> DeviceExecutionMetrics {
        let wallNs = end.monotonicNanoseconds >= start.monotonicNanoseconds
            ? end.monotonicNanoseconds - start.monotonicNanoseconds
            : 0
        let wallMs = Int(wallNs / 1_000_000)

        let userMicros = end.cpuUserMicros >= start.cpuUserMicros
            ? end.cpuUserMicros - start.cpuUserMicros
            : 0
        let sysMicros = end.cpuSystemMicros >= start.cpuSystemMicros
            ? end.cpuSystemMicros - start.cpuSystemMicros
            : 0

        let deltaBytes = Int64(bitPattern: end.physFootprintBytes) &- Int64(bitPattern: start.physFootprintBytes)

        return DeviceExecutionMetrics(
            wallDurationMs: wallMs,
            cpuUserMs: Double(userMicros) / 1000.0,
            cpuSystemMs: Double(sysMicros) / 1000.0,
            memoryFootprintBeforeBytes: start.physFootprintBytes,
            memoryFootprintAfterBytes: end.physFootprintBytes,
            memoryDeltaBytes: deltaBytes,
            thermalState: end.thermalState,
            isLowPowerModeEnabled: end.isLowPowerModeEnabled,
            batteryLevel: end.batteryLevel ?? start.batteryLevel,
            stepsCompleted: stepsCompleted,
            artifactsGenerated: artifactsGenerated,
            deviceModelIdentifier: end.deviceModelIdentifier,
            osVersion: end.osVersion
        )
    }

    public static func currentThermalLevel() -> DeviceThermalLevel {
        DeviceThermalLevel(ProcessInfo.processInfo.thermalState)
    }

    public static func readPhysicalFootprintBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return info.phys_footprint
    }

    private static func readCPUMicroseconds() -> (user: UInt64, system: UInt64) {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return (0, 0) }
        let user = UInt64(max(0, usage.ru_utime.tv_sec)) * 1_000_000 + UInt64(max(0, usage.ru_utime.tv_usec))
        let system = UInt64(max(0, usage.ru_stime.tv_sec)) * 1_000_000 + UInt64(max(0, usage.ru_stime.tv_usec))
        return (user, system)
    }

    private static func readMachineIdentifier() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        return withUnsafePointer(to: &sysinfo.machine) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { cString in
                String(cString: cString)
            }
        }
    }
}
