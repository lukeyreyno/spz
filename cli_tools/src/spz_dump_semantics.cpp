#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "cc/load-spz.h"

#ifdef SPZ_BUILD_EXTENSIONS
#include "semantic-labels-niantic.h"
#include "splat-extensions.h"
#endif

namespace {

void printUsage(const char *prog) {
    std::cerr << "Usage: " << prog << " <input.spz> [output.bin]\n"
              << "\n"
              << "Loads <input.spz>, reads the SPZ_NIANTIC_semantic_labels extension, and\n"
              << "prints a summary (numLabels, channelCount). If <output.bin> is given, the\n"
              << "decompressed per-gaussian uint8 labels are written there as raw bytes\n"
              << "(exactly numPoints long), the inverse of ply_to_spz_semantics.\n"
              << "Exits non-zero if the file has no semantic-labels extension.\n";
}

#ifdef SPZ_BUILD_EXTENSIONS
// Writes the label buffer to disk as raw bytes. Returns false on failure.
bool writeBinaryFile(const std::string &path, const std::vector<uint8_t> &data) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
        std::cerr << "Error: cannot open '" << path << "' for writing" << std::endl;
        return false;
    }
    if (!data.empty()) {
        out.write(reinterpret_cast<const char *>(data.data()),
                  static_cast<std::streamsize>(data.size()));
    }
    return static_cast<bool>(out);
}
#endif

}  // namespace

int main(int argc, char *argv[]) {
#ifndef SPZ_BUILD_EXTENSIONS
    (void)argc;
    (void)argv;
    std::cerr << "Error: this tool requires the SPZ library to be built with "
                 "-DSPZ_BUILD_EXTENSIONS=ON" << std::endl;
    return 1;
#else
    if (argc < 2 || argc > 3) {
        printUsage(argv[0]);
        return 1;
    }

    const std::string spzPath = argv[1];
    const bool hasOutput = (argc == 3);
    const std::string binPath = hasOutput ? argv[2] : std::string();

    try {
        // Load the SPZ; extensions are parsed automatically into cloud.extensions.
        spz::UnpackOptions unpackOptions;
        spz::GaussianCloud cloud = spz::loadSpz(spzPath, unpackOptions);

        // Reader logic: locate the semantic-labels extension by its type.
        auto ext = spz::findExtensionByType<spz::SpzExtensionSemanticLabelsNiantic>(
            cloud.extensions);
        if (!ext) {
            std::cerr << "Error: '" << spzPath
                      << "' has no SPZ_NIANTIC_semantic_labels extension" << std::endl;
            return 2;
        }

        std::cout << "Semantic labels: numLabels=" << ext->labels.size()
                  << " channelCount=" << static_cast<unsigned>(ext->channelCount)
                  << " (numPoints=" << cloud.numPoints << ")" << std::endl;

        if (ext->labels.size() != static_cast<size_t>(cloud.numPoints)) {
            std::cerr << "Warning: label count (" << ext->labels.size()
                      << ") does not match number of gaussians (" << cloud.numPoints
                      << ")" << std::endl;
        }

        if (hasOutput) {
            if (!writeBinaryFile(binPath, ext->labels)) {
                std::cerr << "Error: failed to write '" << binPath << "'" << std::endl;
                return 1;
            }
            std::cout << "Wrote " << ext->labels.size() << " labels to " << binPath
                      << std::endl;
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }
#endif  // SPZ_BUILD_EXTENSIONS
}
