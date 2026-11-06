#include <napi.h>
#include <vulkan/vulkan.h>
#include <unordered_map>
#include <vector>
#include <string>
#include <chrono>
#include <cstring>
#include <thread>
#include <mutex>

static VkInstance g_instance = VK_NULL_HANDLE;
static VkPhysicalDevice g_physicalDevice = VK_NULL_HANDLE;
static VkDevice g_device = VK_NULL_HANDLE;
static VkQueue g_queue = VK_NULL_HANDLE;
static uint32_t g_queueFamily = 0;
static uint32_t g_memoryType = UINT32_MAX;
static VkCommandPool g_commandPool = VK_NULL_HANDLE;

struct BufferInfo {
    VkBuffer buffer;
    VkDeviceMemory memory;
    void* mapped;
    size_t size;
    uint32_t refCount;
};

struct KernelInfo {
    VkShaderModule shader;
    VkPipelineLayout pipelineLayout;
    VkDescriptorSetLayout descLayout;
    VkPipeline pipeline;
    VkDescriptorPool descPool;
    VkDescriptorSet descSet;
    uint32_t bindingCount;
    uint32_t pushConstantSize;
    std::vector<uint32_t> lastBufferHandles;
    // Specialization constant support
    std::vector<uint8_t> spirvData;
    uint32_t specConstantCount;
};

static std::unordered_map<uint32_t, BufferInfo> g_buffers;
static std::unordered_map<uint32_t, KernelInfo> g_kernels;
static uint32_t g_nextHandle = 1;

static uint64_t g_dispatchesCompleted = 0;
static uint64_t g_lastDispatchUs = 0;

static VkQueryPool g_timestampPool = VK_NULL_HANDLE;
static float g_timestampPeriod = 0.0f; // nanoseconds per tick
static uint64_t g_lastGpuExecutionNs = 0;

static int g_refCount = 0;
static std::mutex g_deviceMutex;
static std::mutex g_queueMutex;

// ---------------------------------------------------------------------------

static uint64_t NowUs() {
    return std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------

Napi::Value OpenDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_deviceMutex);

    if (g_refCount > 0) {
        g_refCount++;
        // Return existing device info without re-creating
        VkPhysicalDeviceProperties props{};
        vkGetPhysicalDeviceProperties(g_physicalDevice, &props);
        VkPhysicalDeviceMemoryProperties memProps{};
        vkGetPhysicalDeviceMemoryProperties(g_physicalDevice, &memProps);
        uint64_t budgetBytes = 0;
        for (uint32_t i = 0; i < memProps.memoryHeapCount; i++) {
            if (memProps.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
                budgetBytes += memProps.memoryHeaps[i].size;
        }
        auto vkVer = [](uint32_t v) {
            return std::to_string(VK_VERSION_MAJOR(v)) + "." +
                   std::to_string(VK_VERSION_MINOR(v)) + "." +
                   std::to_string(VK_VERSION_PATCH(v));
        };
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("deviceName", Napi::String::New(env, props.deviceName));
        obj.Set("driverVersion", Napi::String::New(env, vkVer(props.driverVersion)));
        obj.Set("apiVersion", Napi::String::New(env, vkVer(props.apiVersion)));
        obj.Set("memoryBudgetMB", Napi::Number::New(env, (double)(budgetBytes / (1024 * 1024))));
        return obj;
    }

    VkApplicationInfo appInfo{};
    appInfo.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    appInfo.apiVersion = VK_API_VERSION_1_2;

    VkInstanceCreateInfo ici{};
    ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo = &appInfo;

    VkResult r = vkCreateInstance(&ici, nullptr, &g_instance);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkCreateInstance failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t devCount = 0;
    vkEnumeratePhysicalDevices(g_instance, &devCount, nullptr);
    if (devCount == 0) {
        Napi::Error::New(env, "No Vulkan physical devices found").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::vector<VkPhysicalDevice> devs(devCount);
    vkEnumeratePhysicalDevices(g_instance, &devCount, devs.data());

    // Prefer a hardware device; use a software renderer (llvmpipe) only if nothing else exists
    for (auto pd : devs) {
        VkPhysicalDeviceProperties props{};
        vkGetPhysicalDeviceProperties(pd, &props);
        if (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU) continue;
        g_physicalDevice = pd;
        break;
    }
    if (g_physicalDevice == VK_NULL_HANDLE) {
        g_physicalDevice = devs[0];
    }

    uint32_t qfCount = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(g_physicalDevice, &qfCount, nullptr);
    std::vector<VkQueueFamilyProperties> qfs(qfCount);
    vkGetPhysicalDeviceQueueFamilyProperties(g_physicalDevice, &qfCount, qfs.data());

    bool found = false;
    for (uint32_t i = 0; i < qfCount; i++) {
        if (qfs[i].queueFlags & VK_QUEUE_COMPUTE_BIT) {
            g_queueFamily = i;
            found = true;
            break;
        }
    }
    if (!found) {
        Napi::Error::New(env, "No compute queue family found").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci{};
    qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = g_queueFamily;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;

    VkDeviceCreateInfo dci{};
    dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;

    r = vkCreateDevice(g_physicalDevice, &dci, nullptr, &g_device);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkCreateDevice failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    vkGetDeviceQueue(g_device, g_queueFamily, 0, &g_queue);

    VkPhysicalDeviceMemoryProperties memProps{};
    vkGetPhysicalDeviceMemoryProperties(g_physicalDevice, &memProps);

    // On unified memory, look for HOST_VISIBLE | HOST_COHERENT | DEVICE_LOCAL
    const uint32_t desired =
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
        VK_MEMORY_PROPERTY_HOST_COHERENT_BIT |
        VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
    for (uint32_t i = 0; i < memProps.memoryTypeCount; i++) {
        if ((memProps.memoryTypes[i].propertyFlags & desired) == desired) {
            g_memoryType = i;
            break;
        }
    }
    // If no fully unified type, fall back to HOST_VISIBLE | HOST_COHERENT
    if (g_memoryType == UINT32_MAX) {
        const uint32_t fallback =
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        for (uint32_t i = 0; i < memProps.memoryTypeCount; i++) {
            if ((memProps.memoryTypes[i].propertyFlags & fallback) == fallback) {
                g_memoryType = i;
                break;
            }
        }
    }
    if (g_memoryType == UINT32_MAX) {
        Napi::Error::New(env, "No suitable memory type found").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkCommandPoolCreateInfo cpci{};
    cpci.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    cpci.queueFamilyIndex = g_queueFamily;
    cpci.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    r = vkCreateCommandPool(g_device, &cpci, nullptr, &g_commandPool);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkCreateCommandPool failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Query the timestamp period from device properties
    VkPhysicalDeviceProperties tsProps{};
    vkGetPhysicalDeviceProperties(g_physicalDevice, &tsProps);
    g_timestampPeriod = tsProps.limits.timestampPeriod;

    // Create timestamp query pool (2 queries per dispatch: before + after)
    if (g_timestampPeriod > 0.0f) {
        VkQueryPoolCreateInfo qpci{};
        qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
        qpci.queryType = VK_QUERY_TYPE_TIMESTAMP;
        qpci.queryCount = 2;  // start + end
        r = vkCreateQueryPool(g_device, &qpci, nullptr, &g_timestampPool);
        if (r != VK_SUCCESS) {
            g_timestampPool = VK_NULL_HANDLE;  // non-fatal, just disable timestamps
        }
    }

    VkPhysicalDeviceProperties props{};
    vkGetPhysicalDeviceProperties(g_physicalDevice, &props);

    uint64_t budgetBytes = 0;
    for (uint32_t i = 0; i < memProps.memoryHeapCount; i++) {
        if (memProps.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) {
            budgetBytes += memProps.memoryHeaps[i].size;
        }
    }

    auto vkVer = [](uint32_t v) {
        return std::to_string(VK_VERSION_MAJOR(v)) + "." +
               std::to_string(VK_VERSION_MINOR(v)) + "." +
               std::to_string(VK_VERSION_PATCH(v));
    };

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("deviceName", Napi::String::New(env, props.deviceName));
    obj.Set("driverVersion", Napi::String::New(env, vkVer(props.driverVersion)));
    obj.Set("apiVersion", Napi::String::New(env, vkVer(props.apiVersion)));
    obj.Set("memoryBudgetMB", Napi::Number::New(env, (double)(budgetBytes / (1024 * 1024))));
    g_refCount = 1;
    return obj;
}

// ---------------------------------------------------------------------------

Napi::Value CreateBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::Error::New(env, "createBuffer(byteSize: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    size_t byteSize = (size_t)info[0].As<Napi::Number>().Uint32Value();

    VkBufferCreateInfo bci{};
    bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bci.size = byteSize;
    bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    BufferInfo bi{};
    bi.size = byteSize;

    VkResult r = vkCreateBuffer(g_device, &bci, nullptr, &bi.buffer);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkCreateBuffer failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkMemoryRequirements memReq{};
    vkGetBufferMemoryRequirements(g_device, bi.buffer, &memReq);

    VkMemoryAllocateInfo mai{};
    mai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    mai.allocationSize = memReq.size;
    mai.memoryTypeIndex = g_memoryType;

    r = vkAllocateMemory(g_device, &mai, nullptr, &bi.memory);
    if (r != VK_SUCCESS) {
        vkDestroyBuffer(g_device, bi.buffer, nullptr);
        Napi::Error::New(env, "vkAllocateMemory failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    r = vkBindBufferMemory(g_device, bi.buffer, bi.memory, 0);
    if (r != VK_SUCCESS) {
        vkFreeMemory(g_device, bi.memory, nullptr);
        vkDestroyBuffer(g_device, bi.buffer, nullptr);
        Napi::Error::New(env, "vkBindBufferMemory failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    r = vkMapMemory(g_device, bi.memory, 0, byteSize, 0, &bi.mapped);
    if (r != VK_SUCCESS) {
        vkFreeMemory(g_device, bi.memory, nullptr);
        vkDestroyBuffer(g_device, bi.buffer, nullptr);
        Napi::Error::New(env, "vkMapMemory failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t handle = g_nextHandle++;
    bi.refCount = 1;
    g_buffers[handle] = bi;

    // No destructor callback — Vulkan owns this memory; addon frees in destroyBuffer
    auto ab = Napi::ArrayBuffer::New(env, bi.mapped, byteSize);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("handle", Napi::Number::New(env, handle));
    obj.Set("buffer", ab);
    return obj;
}

// ---------------------------------------------------------------------------

Napi::Value DestroyBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::Error::New(env, "destroyBuffer(handle: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto it = g_buffers.find(handle);
    if (it == g_buffers.end()) return env.Undefined();
    if (--it->second.refCount > 0) return env.Undefined();

    vkUnmapMemory(g_device, it->second.memory);
    vkDestroyBuffer(g_device, it->second.buffer, nullptr);
    vkFreeMemory(g_device, it->second.memory, nullptr);
    g_buffers.erase(it);
    return env.Undefined();
}

// ---------------------------------------------------------------------------

Napi::Value RegisterKernel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::Error::New(env, "registerKernel(spirvBuffer, bindingCount, pushConstantSize, workgroupSizeX[, specConstantCount[, specValuesBuffer]])").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto spirvAb = info[0].As<Napi::ArrayBuffer>();
    uint32_t bindingCount = info[1].As<Napi::Number>().Uint32Value();
    uint32_t pushConstantSize = info[2].As<Napi::Number>().Uint32Value();
    // workgroupSizeX is baked into the SPIR-V; recorded for documentation purposes
    // uint32_t workgroupSizeX = info[3].As<Napi::Number>().Uint32Value();

    // Optional specialization constant params
    uint32_t specCount = 0;
    void* specData = nullptr;
    size_t specDataSize = 0;
    if (info.Length() >= 5 && info[4].IsNumber()) {
        specCount = info[4].As<Napi::Number>().Uint32Value();
    }
    if (info.Length() >= 6 && info[5].IsArrayBuffer()) {
        auto specAb = info[5].As<Napi::ArrayBuffer>();
        specData = specAb.Data();
        specDataSize = specAb.ByteLength();
    }

    KernelInfo ki{};
    ki.bindingCount = bindingCount;
    ki.pushConstantSize = pushConstantSize;
    ki.specConstantCount = specCount;

    // Store SPIR-V for later respecialization
    const uint8_t* spirvBuf = reinterpret_cast<const uint8_t*>(spirvAb.Data());
    size_t spirvLen = spirvAb.ByteLength();
    ki.spirvData.assign(spirvBuf, spirvBuf + spirvLen);

    VkShaderModuleCreateInfo smci{};
    smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    smci.codeSize = spirvLen;
    smci.pCode = reinterpret_cast<const uint32_t*>(spirvBuf);

    VkResult r = vkCreateShaderModule(g_device, &smci, nullptr, &ki.shader);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkCreateShaderModule failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::vector<VkDescriptorSetLayoutBinding> bindings(bindingCount);
    for (uint32_t i = 0; i < bindingCount; i++) {
        bindings[i].binding = i;
        bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        bindings[i].descriptorCount = 1;
        bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    }

    VkDescriptorSetLayoutCreateInfo dslci{};
    dslci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    dslci.bindingCount = bindingCount;
    dslci.pBindings = bindings.data();

    r = vkCreateDescriptorSetLayout(g_device, &dslci, nullptr, &ki.descLayout);
    if (r != VK_SUCCESS) {
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
        Napi::Error::New(env, "vkCreateDescriptorSetLayout failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkPushConstantRange pcr{};
    pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    pcr.offset = 0;
    pcr.size = pushConstantSize > 0 ? pushConstantSize : 4; // Vulkan requires size > 0

    VkPipelineLayoutCreateInfo plci{};
    plci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plci.setLayoutCount = 1;
    plci.pSetLayouts = &ki.descLayout;
    if (pushConstantSize > 0) {
        plci.pushConstantRangeCount = 1;
        plci.pPushConstantRanges = &pcr;
    }

    r = vkCreatePipelineLayout(g_device, &plci, nullptr, &ki.pipelineLayout);
    if (r != VK_SUCCESS) {
        vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
        Napi::Error::New(env, "vkCreatePipelineLayout failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Build specialization info if spec constants are present
    std::vector<VkSpecializationMapEntry> specEntries;
    VkSpecializationInfo specInfo{};
    std::vector<uint8_t> specDataCopy;
    if (specCount > 0 && specDataSize > 0) {
        specEntries.resize(specCount);
        for (uint32_t i = 0; i < specCount; i++) {
            specEntries[i].constantID = i;
            specEntries[i].offset    = i * 4;  // 4 bytes (u32) per constant
            specEntries[i].size      = 4;
        }
        // Copy spec data so it stays valid for the pipeline create call
        specDataCopy.assign(reinterpret_cast<const uint8_t*>(specData),
                            reinterpret_cast<const uint8_t*>(specData) + specDataSize);
        specInfo.mapEntryCount = specCount;
        specInfo.pMapEntries   = specEntries.data();
        specInfo.dataSize      = specDataCopy.size();
        specInfo.pData         = specDataCopy.data();
    }

    VkPipelineShaderStageCreateInfo stage{};
    stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    stage.module = ki.shader;
    stage.pName = "main";
    if (specCount > 0 && specDataSize > 0) {
        stage.pSpecializationInfo = &specInfo;
    }

    VkComputePipelineCreateInfo cpci{};
    cpci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    cpci.stage = stage;
    cpci.layout = ki.pipelineLayout;

    r = vkCreateComputePipelines(g_device, VK_NULL_HANDLE, 1, &cpci, nullptr, &ki.pipeline);
    if (r != VK_SUCCESS) {
        vkDestroyPipelineLayout(g_device, ki.pipelineLayout, nullptr);
        vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
        Napi::Error::New(env, "vkCreateComputePipelines failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkDescriptorPoolSize poolSize{};
    poolSize.type = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    poolSize.descriptorCount = bindingCount > 0 ? bindingCount : 1;

    VkDescriptorPoolCreateInfo dpci{};
    dpci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    dpci.maxSets = 1;
    dpci.poolSizeCount = 1;
    dpci.pPoolSizes = &poolSize;

    r = vkCreateDescriptorPool(g_device, &dpci, nullptr, &ki.descPool);
    if (r != VK_SUCCESS) {
        vkDestroyPipeline(g_device, ki.pipeline, nullptr);
        vkDestroyPipelineLayout(g_device, ki.pipelineLayout, nullptr);
        vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
        Napi::Error::New(env, "vkCreateDescriptorPool failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkDescriptorSetAllocateInfo dsai{};
    dsai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    dsai.descriptorPool = ki.descPool;
    dsai.descriptorSetCount = 1;
    dsai.pSetLayouts = &ki.descLayout;

    r = vkAllocateDescriptorSets(g_device, &dsai, &ki.descSet);
    if (r != VK_SUCCESS) {
        vkDestroyDescriptorPool(g_device, ki.descPool, nullptr);
        vkDestroyPipeline(g_device, ki.pipeline, nullptr);
        vkDestroyPipelineLayout(g_device, ki.pipelineLayout, nullptr);
        vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
        Napi::Error::New(env, "vkAllocateDescriptorSets failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t handle = g_nextHandle++;
    g_kernels[handle] = ki;
    return Napi::Number::New(env, handle);
}

// ---------------------------------------------------------------------------

Napi::Value RespecializeKernel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArrayBuffer()) {
        Napi::Error::New(env, "respecializeKernel(kernelHandle, specValuesBuffer)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto specAb = info[1].As<Napi::ArrayBuffer>();

    auto kit = g_kernels.find(handle);
    if (kit == g_kernels.end()) {
        Napi::Error::New(env, "respecializeKernel: invalid kernel handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    KernelInfo& ki = kit->second;

    if (ki.specConstantCount == 0 || ki.spirvData.empty()) {
        Napi::Error::New(env, "respecializeKernel: kernel has no specialization constants").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Build new shader module from stored SPIR-V
    VkShaderModuleCreateInfo smci{};
    smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    smci.codeSize = ki.spirvData.size();
    smci.pCode = reinterpret_cast<const uint32_t*>(ki.spirvData.data());

    VkShaderModule newShader = VK_NULL_HANDLE;
    VkResult r = vkCreateShaderModule(g_device, &smci, nullptr, &newShader);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "respecializeKernel: vkCreateShaderModule failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Build specialization info from new values
    uint32_t specCount = ki.specConstantCount;
    std::vector<VkSpecializationMapEntry> specEntries(specCount);
    for (uint32_t i = 0; i < specCount; i++) {
        specEntries[i].constantID = i;
        specEntries[i].offset     = i * 4;
        specEntries[i].size       = 4;
    }
    VkSpecializationInfo specInfo{};
    specInfo.mapEntryCount = specCount;
    specInfo.pMapEntries   = specEntries.data();
    specInfo.dataSize      = specAb.ByteLength();
    specInfo.pData         = specAb.Data();

    VkPipelineShaderStageCreateInfo stage{};
    stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    stage.module = newShader;
    stage.pName  = "main";
    stage.pSpecializationInfo = &specInfo;

    VkComputePipelineCreateInfo cpci{};
    cpci.sType  = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    cpci.stage  = stage;
    cpci.layout = ki.pipelineLayout;

    VkPipeline newPipeline = VK_NULL_HANDLE;
    r = vkCreateComputePipelines(g_device, VK_NULL_HANDLE, 1, &cpci, nullptr, &newPipeline);
    vkDestroyShaderModule(g_device, newShader, nullptr);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "respecializeKernel: vkCreateComputePipelines failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Swap old pipeline for new one (no caching — swap strategy as specified)
    vkDestroyPipeline(g_device, ki.pipeline, nullptr);
    ki.pipeline = newPipeline;

    return env.Undefined();
}

// ---------------------------------------------------------------------------

Napi::Value DestroyKernel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) return env.Undefined();
    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto it = g_kernels.find(handle);
    if (it == g_kernels.end()) return env.Undefined();
    auto& ki = it->second;
    ki.lastBufferHandles.clear();
    vkDestroyDescriptorPool(g_device, ki.descPool, nullptr);
    vkDestroyPipeline(g_device, ki.pipeline, nullptr);
    vkDestroyPipelineLayout(g_device, ki.pipelineLayout, nullptr);
    vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
    vkDestroyShaderModule(g_device, ki.shader, nullptr);
    g_kernels.erase(it);
    return env.Undefined();
}

// ---------------------------------------------------------------------------

struct DispatchCtx {
    VkDevice device;
    VkFence fence;
    VkCommandBuffer cmd;
    VkCommandPool pool;
    uint64_t submitUs;
    bool hasTimestamps;
};

class DispatchWorker : public Napi::AsyncWorker {
public:
    DispatchWorker(Napi::Env env, Napi::Promise::Deferred deferred, DispatchCtx ctx)
        : Napi::AsyncWorker(env), deferred_(deferred), ctx_(ctx) {}

    void Execute() override {
        VkResult r = vkWaitForFences(ctx_.device, 1, &ctx_.fence, VK_TRUE, 5000000000ULL);
        uint64_t doneUs = NowUs();
        elapsed_ = doneUs - ctx_.submitUs;
        if (r == VK_TIMEOUT) {
            SetError("GPU dispatch timed out after 5 seconds");
        } else if (r != VK_SUCCESS) {
            SetError("vkWaitForFences failed: " + std::to_string(r));
        }
    }

    void OnOK() override {
        vkDestroyFence(ctx_.device, ctx_.fence, nullptr);
        vkFreeCommandBuffers(ctx_.device, ctx_.pool, 1, &ctx_.cmd);
        g_dispatchesCompleted++;
        g_lastDispatchUs = elapsed_;
        if (ctx_.hasTimestamps) {
            uint64_t timestamps[2] = {0, 0};
            VkResult tr = vkGetQueryPoolResults(ctx_.device, g_timestampPool, 0, 2,
                sizeof(timestamps), timestamps, sizeof(uint64_t),
                VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
            if (tr == VK_SUCCESS && timestamps[1] > timestamps[0]) {
                g_lastGpuExecutionNs = (uint64_t)((timestamps[1] - timestamps[0]) * g_timestampPeriod);
            }
        }
        deferred_.Resolve(Env().Undefined());
    }

    void OnError(const Napi::Error& e) override {
        vkDestroyFence(ctx_.device, ctx_.fence, nullptr);
        vkFreeCommandBuffers(ctx_.device, ctx_.pool, 1, &ctx_.cmd);
        deferred_.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred deferred_;
    DispatchCtx ctx_;
    uint64_t elapsed_ = 0;
};

// ---------------------------------------------------------------------------

Napi::Value Dispatch(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::Error::New(env, "dispatch(kernelHandle, bufferHandles[], pushConstantsBuffer, groupsX, groupsY, groupsZ)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t kernelHandle = info[0].As<Napi::Number>().Uint32Value();
    auto bufHandlesArr = info[1].As<Napi::Array>();
    auto pcAb = info[2].As<Napi::ArrayBuffer>();
    uint32_t groupsX = info[3].As<Napi::Number>().Uint32Value();
    uint32_t groupsY = info[4].As<Napi::Number>().Uint32Value();
    uint32_t groupsZ = info[5].As<Napi::Number>().Uint32Value();

    auto kit = g_kernels.find(kernelHandle);
    if (kit == g_kernels.end()) {
        Napi::Error::New(env, "Invalid kernel handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    KernelInfo& ki = kit->second;

    uint32_t numBufs = bufHandlesArr.Length();
    std::vector<uint32_t> currentHandles(numBufs);
    for (uint32_t i = 0; i < numBufs; i++) {
        currentHandles[i] = bufHandlesArr.Get(i).As<Napi::Number>().Uint32Value();
    }

    bool buffersChanged = (currentHandles != ki.lastBufferHandles);

    if (buffersChanged) {
        std::vector<VkDescriptorBufferInfo> bufInfos(numBufs);
        std::vector<VkWriteDescriptorSet> writes(numBufs);

        for (uint32_t i = 0; i < numBufs; i++) {
            auto bit = g_buffers.find(currentHandles[i]);
            if (bit == g_buffers.end()) {
                Napi::Error::New(env, "Invalid buffer handle: " + std::to_string(currentHandles[i])).ThrowAsJavaScriptException();
                return env.Undefined();
            }
            bufInfos[i].buffer = bit->second.buffer;
            bufInfos[i].offset = 0;
            bufInfos[i].range = bit->second.size;

            writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
            writes[i].dstSet = ki.descSet;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo = &bufInfos[i];
        }
        if (numBufs > 0)
            vkUpdateDescriptorSets(g_device, numBufs, writes.data(), 0, nullptr);
        ki.lastBufferHandles = std::move(currentHandles);
    }

    VkCommandBufferAllocateInfo cbai{};
    cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cbai.commandPool = g_commandPool;
    cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cbai.commandBufferCount = 1;

    VkCommandBuffer cmd = VK_NULL_HANDLE;
    VkResult r = vkAllocateCommandBuffers(g_device, &cbai, &cmd);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "vkAllocateCommandBuffers failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkCommandBufferBeginInfo cbbi{};
    cbbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    cbbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &cbbi);

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, ki.pipeline);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, ki.pipelineLayout, 0, 1, &ki.descSet, 0, nullptr);
    if (ki.pushConstantSize > 0 && pcAb.ByteLength() > 0) {
        vkCmdPushConstants(cmd, ki.pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, ki.pushConstantSize, pcAb.Data());
    }
    // Reset and write timestamps around dispatch
    if (g_timestampPool != VK_NULL_HANDLE) {
        vkCmdResetQueryPool(cmd, g_timestampPool, 0, 2);
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_timestampPool, 0);
    }

    vkCmdDispatch(cmd, groupsX, groupsY, groupsZ);

    if (g_timestampPool != VK_NULL_HANDLE) {
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_timestampPool, 1);
    }
    vkEndCommandBuffer(cmd);

    VkFenceCreateInfo fci{};
    fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    VkFence fence = VK_NULL_HANDLE;
    r = vkCreateFence(g_device, &fci, nullptr, &fence);
    if (r != VK_SUCCESS) {
        vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
        Napi::Error::New(env, "vkCreateFence failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;

    uint64_t submitUs = NowUs();
    {
        std::lock_guard<std::mutex> qlock(g_queueMutex);
        r = vkQueueSubmit(g_queue, 1, &si, fence);
    }
    if (r != VK_SUCCESS) {
        vkDestroyFence(g_device, fence, nullptr);
        vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
        Napi::Error::New(env, "vkQueueSubmit failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    DispatchCtx ctx{ g_device, fence, cmd, g_commandPool, submitUs, g_timestampPool != VK_NULL_HANDLE };
    auto* worker = new DispatchWorker(env, deferred, ctx);
    worker->Queue();
    return deferred.Promise();
}


Napi::Value DispatchChain(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::Error::New(env, "dispatchChain(specs[])").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto specs = info[0].As<Napi::Array>();
    uint32_t chainLen = specs.Length();
    if (chainLen == 0) {
        auto deferred = Napi::Promise::Deferred::New(env);
        deferred.Resolve(env.Undefined());
        return deferred.Promise();
    }

    // Allocate ONE command buffer for the entire chain
    VkCommandBufferAllocateInfo cbai{};
    cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cbai.commandPool = g_commandPool;
    cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cbai.commandBufferCount = 1;

    VkCommandBuffer cmd = VK_NULL_HANDLE;
    VkResult r = vkAllocateCommandBuffers(g_device, &cbai, &cmd);
    if (r != VK_SUCCESS) {
        Napi::Error::New(env, "dispatchChain: vkAllocateCommandBuffers failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkCommandBufferBeginInfo cbbi{};
    cbbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    cbbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &cbbi);

    // Timestamp: start of entire chain
    if (g_timestampPool != VK_NULL_HANDLE) {
        vkCmdResetQueryPool(cmd, g_timestampPool, 0, 2);
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_timestampPool, 0);
    }

    for (uint32_t s = 0; s < chainLen; s++) {
        auto spec = specs.Get(s).As<Napi::Object>();
        uint32_t kernelHandle = spec.Get("kernel").As<Napi::Number>().Uint32Value();
        auto bufArr = spec.Get("buffers").As<Napi::Array>();
        auto pcAb = spec.Get("pushConstants").As<Napi::ArrayBuffer>();
        uint32_t gx = spec.Get("groupsX").As<Napi::Number>().Uint32Value();
        uint32_t gy = spec.Has("groupsY") ? spec.Get("groupsY").As<Napi::Number>().Uint32Value() : 1;
        uint32_t gz = spec.Has("groupsZ") ? spec.Get("groupsZ").As<Napi::Number>().Uint32Value() : 1;

        auto kit = g_kernels.find(kernelHandle);
        if (kit == g_kernels.end()) {
            vkEndCommandBuffer(cmd);
            vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
            Napi::Error::New(env, "dispatchChain: invalid kernel handle at index " + std::to_string(s)).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        KernelInfo& ki = kit->second;

        // Insert compute->compute memory barrier between dispatches
        if (s > 0) {
            VkMemoryBarrier barrier{};
            barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
            barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
            barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
            vkCmdPipelineBarrier(cmd,
                VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                0, 1, &barrier, 0, nullptr, 0, nullptr);
        }

        // Update descriptor sets for this dispatch
        uint32_t numBufs = bufArr.Length();
        std::vector<uint32_t> currentHandles(numBufs);
        for (uint32_t i = 0; i < numBufs; i++) {
            currentHandles[i] = bufArr.Get(i).As<Napi::Number>().Uint32Value();
        }

        bool buffersChanged = (currentHandles != ki.lastBufferHandles);
        if (buffersChanged) {
            std::vector<VkDescriptorBufferInfo> bufInfos(numBufs);
            std::vector<VkWriteDescriptorSet> writes(numBufs);
            for (uint32_t i = 0; i < numBufs; i++) {
                auto bit = g_buffers.find(currentHandles[i]);
                if (bit == g_buffers.end()) {
                    vkEndCommandBuffer(cmd);
                    vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
                    Napi::Error::New(env, "dispatchChain: invalid buffer handle " + std::to_string(currentHandles[i]) + " at spec index " + std::to_string(s)).ThrowAsJavaScriptException();
                    return env.Undefined();
                }
                bufInfos[i].buffer = bit->second.buffer;
                bufInfos[i].offset = 0;
                bufInfos[i].range = bit->second.size;

                writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
                writes[i].dstSet = ki.descSet;
                writes[i].dstBinding = i;
                writes[i].descriptorCount = 1;
                writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
                writes[i].pBufferInfo = &bufInfos[i];
            }
            if (numBufs > 0)
                vkUpdateDescriptorSets(g_device, numBufs, writes.data(), 0, nullptr);
            ki.lastBufferHandles = std::move(currentHandles);
        }

        // Record commands for this dispatch
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, ki.pipeline);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, ki.pipelineLayout, 0, 1, &ki.descSet, 0, nullptr);
        if (ki.pushConstantSize > 0 && pcAb.ByteLength() > 0) {
            vkCmdPushConstants(cmd, ki.pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, ki.pushConstantSize, pcAb.Data());
        }
        vkCmdDispatch(cmd, gx, gy, gz);
    }

    // Timestamp: end of entire chain
    if (g_timestampPool != VK_NULL_HANDLE) {
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_timestampPool, 1);
    }
    vkEndCommandBuffer(cmd);

    VkFenceCreateInfo fci{};
    fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    VkFence fence = VK_NULL_HANDLE;
    r = vkCreateFence(g_device, &fci, nullptr, &fence);
    if (r != VK_SUCCESS) {
        vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
        Napi::Error::New(env, "dispatchChain: vkCreateFence failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;

    uint64_t submitUs = NowUs();
    {
        std::lock_guard<std::mutex> qlock(g_queueMutex);
        r = vkQueueSubmit(g_queue, 1, &si, fence);
    }
    if (r != VK_SUCCESS) {
        vkDestroyFence(g_device, fence, nullptr);
        vkFreeCommandBuffers(g_device, g_commandPool, 1, &cmd);
        Napi::Error::New(env, "dispatchChain: vkQueueSubmit failed: " + std::to_string(r)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    DispatchCtx ctx{ g_device, fence, cmd, g_commandPool, submitUs, g_timestampPool != VK_NULL_HANDLE };
    auto* worker = new DispatchWorker(env, deferred, ctx);
    worker->Queue();
    return deferred.Promise();
}


Napi::Value RefBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::Error::New(env, "refBuffer(handle: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto it = g_buffers.find(handle);
    if (it == g_buffers.end()) {
        Napi::Error::New(env, "refBuffer: unknown handle " + std::to_string(handle)).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    it->second.refCount++;
    return env.Undefined();
}

Napi::Value GetBufferView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::Error::New(env, "getBufferView(handle: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto it = g_buffers.find(handle);
    if (it == g_buffers.end()) {
        Napi::Error::New(env, "getBufferView: unknown handle " + std::to_string(handle)).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto& bi = it->second;
    return Napi::ArrayBuffer::New(env, bi.mapped, bi.size);
}

// ---------------------------------------------------------------------------

Napi::Value DestroyDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_deviceMutex);
    if (g_device == VK_NULL_HANDLE) return env.Undefined();
    if (--g_refCount > 0) return env.Undefined();

    vkQueueWaitIdle(g_queue);

    for (auto& [h, bi] : g_buffers) {
        vkUnmapMemory(g_device, bi.memory);
        vkDestroyBuffer(g_device, bi.buffer, nullptr);
        vkFreeMemory(g_device, bi.memory, nullptr);
    }
    g_buffers.clear();

    for (auto& [h, ki] : g_kernels) {
        vkDestroyDescriptorPool(g_device, ki.descPool, nullptr);
        vkDestroyPipeline(g_device, ki.pipeline, nullptr);
        vkDestroyPipelineLayout(g_device, ki.pipelineLayout, nullptr);
        vkDestroyDescriptorSetLayout(g_device, ki.descLayout, nullptr);
        vkDestroyShaderModule(g_device, ki.shader, nullptr);
    }
    g_kernels.clear();

    if (g_timestampPool != VK_NULL_HANDLE) {
        vkDestroyQueryPool(g_device, g_timestampPool, nullptr);
        g_timestampPool = VK_NULL_HANDLE;
    }

    if (g_commandPool != VK_NULL_HANDLE) {
        vkDestroyCommandPool(g_device, g_commandPool, nullptr);
        g_commandPool = VK_NULL_HANDLE;
    }

    vkDestroyDevice(g_device, nullptr);
    g_device = VK_NULL_HANDLE;

    vkDestroyInstance(g_instance, nullptr);
    g_instance = VK_NULL_HANDLE;
    g_physicalDevice = VK_NULL_HANDLE;
    g_queue = VK_NULL_HANDLE;
    g_memoryType = UINT32_MAX;

    return env.Undefined();
}

// ---------------------------------------------------------------------------

Napi::Value Stats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint64_t totalBytes = 0;
    for (auto& [h, bi] : g_buffers) totalBytes += bi.size;

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("buffersAllocated", Napi::Number::New(env, (double)g_buffers.size()));
    obj.Set("buffersBytes", Napi::Number::New(env, (double)totalBytes));
    obj.Set("kernelsRegistered", Napi::Number::New(env, (double)g_kernels.size()));
    obj.Set("dispatchesCompleted", Napi::Number::New(env, (double)g_dispatchesCompleted));
    obj.Set("lastDispatchUs", Napi::Number::New(env, (double)g_lastDispatchUs));
    obj.Set("lastGpuExecutionUs", Napi::Number::New(env, (double)(g_lastGpuExecutionNs / 1000)));
    return obj;
}

// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("openDevice",     Napi::Function::New(env, OpenDevice));
    exports.Set("createBuffer",   Napi::Function::New(env, CreateBuffer));
    exports.Set("destroyBuffer",  Napi::Function::New(env, DestroyBuffer));
    exports.Set("registerKernel",    Napi::Function::New(env, RegisterKernel));
    exports.Set("respecializeKernel",Napi::Function::New(env, RespecializeKernel));
    exports.Set("destroyKernel",     Napi::Function::New(env, DestroyKernel));
    exports.Set("dispatch",       Napi::Function::New(env, Dispatch));
    exports.Set("dispatchChain",  Napi::Function::New(env, DispatchChain));
    exports.Set("destroyDevice",  Napi::Function::New(env, DestroyDevice));
    exports.Set("stats",          Napi::Function::New(env, Stats));
    exports.Set("refBuffer",      Napi::Function::New(env, RefBuffer));
    exports.Set("getBufferView",  Napi::Function::New(env, GetBufferView));
    return exports;
}

NODE_API_MODULE(gpu_addon, Init)
