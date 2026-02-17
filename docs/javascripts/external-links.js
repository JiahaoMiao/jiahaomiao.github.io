document.addEventListener("DOMContentLoaded", function() {
    var links = document.links;
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        
        // CONDITION 1: External Links
        // If the hostname is different from the current site
        var isExternal = link.hostname != window.location.hostname;
        
        // CONDITION 2: PDF Files
        // If the href ends with .pdf (case insensitive)
        var isPdf = link.href.toLowerCase().endsWith('.pdf');

        if (isExternal || isPdf) {
            link.target = '_blank';
            link.rel = 'noopener'; // Security best practice
        }
    }
});